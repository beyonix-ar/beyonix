import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  canConfirmOrder,
  consumeOrderReservation,
  createStore,
  getAvailableForSession,
  purgeExpiredReservations,
  releaseSessionReservations,
  reserveStock,
} from "./stock-reservation-model.ts"

const TTL = 30 * 60 * 1000
const T0 = 1_800_000_000_000
const SESSION_A = "session-a-checkout-0001"
const SESSION_B = "session-b-checkout-0002"

function singleProduct(stock: number) {
  return createStore([{ productId: 1, stock }])
}

function item(quantity: number, variantId: number | null = null) {
  return { productId: 1, variantId, quantity }
}

// --- CASO 1: dos reservas simultáneas por la última unidad ---

test("CASO 1: con stock 1, dos sesiones piden 1 y sólo una gana", () => {
  const store = singleProduct(1)

  const a = reserveStock(store, {
    sessionId: SESSION_A,
    items: [item(1)],
    now: T0,
    ttlMs: TTL,
  })
  const b = reserveStock(store, {
    sessionId: SESSION_B,
    items: [item(1)],
    now: T0,
    ttlMs: TTL,
  })

  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  if (b.ok) return
  assert.equal(b.reason, "insufficient_stock")
  // B ve 0 disponible aunque el stock FÍSICO siga siendo 1: la unidad está
  // gravada por la reserva de A.
  assert.equal(getAvailableForSession(store, { productId: 1 }, SESSION_B, T0), 0)
  assert.equal(store.stock.get("1::"), 1)
})

// --- CASO 2 y 3: cantidades ---

test("CASO 2: stock 5, A reserva 3 y B no puede reservar 3", () => {
  const store = singleProduct(5)

  assert.equal(
    reserveStock(store, { sessionId: SESSION_A, items: [item(3)], now: T0, ttlMs: TTL }).ok,
    true,
  )
  assert.equal(
    reserveStock(store, { sessionId: SESSION_B, items: [item(3)], now: T0, ttlMs: TTL }).ok,
    false,
  )
  assert.equal(getAvailableForSession(store, { productId: 1 }, SESSION_B, T0), 2)
})

test("CASO 3: stock 5, A reserva 3 y B reserva 2: ambas válidas", () => {
  const store = singleProduct(5)

  assert.equal(
    reserveStock(store, { sessionId: SESSION_A, items: [item(3)], now: T0, ttlMs: TTL }).ok,
    true,
  )
  assert.equal(
    reserveStock(store, { sessionId: SESSION_B, items: [item(2)], now: T0, ttlMs: TTL }).ok,
    true,
  )
  assert.equal(getAvailableForSession(store, { productId: 1 }, "session-c-000000", T0), 0)
})

// --- CASO 4 y 5: expiración ---

test("CASO 4: una reserva vencida devuelve las unidades a disponibilidad", () => {
  const store = singleProduct(1)

  reserveStock(store, { sessionId: SESSION_A, items: [item(1)], now: T0, ttlMs: TTL })
  assert.equal(getAvailableForSession(store, { productId: 1 }, SESSION_B, T0), 0)

  const afterExpiry = T0 + TTL + 1
  assert.equal(getAvailableForSession(store, { productId: 1 }, SESSION_B, afterExpiry), 1)
  assert.equal(
    reserveStock(store, {
      sessionId: SESSION_B,
      items: [item(1)],
      now: afterExpiry,
      ttlMs: TTL,
    }).ok,
    true,
  )
})

test("CASO 5: expirar dos veces da exactamente el mismo resultado y NUNCA suma stock", () => {
  const store = singleProduct(4)
  reserveStock(store, { sessionId: SESSION_A, items: [item(2)], now: T0, ttlMs: TTL })

  const afterExpiry = T0 + TTL + 1
  const first = purgeExpiredReservations(store, afterExpiry)
  const second = purgeExpiredReservations(store, afterExpiry)

  assert.equal(first, 1)
  assert.equal(second, 0)
  assert.equal(store.reservations.length, 0)
  // El stock físico no se tocó en ningún momento: la reserva nunca lo restó,
  // así que expirarla tampoco puede sumarlo.
  assert.equal(store.stock.get("1::"), 4)
})

// --- CASO 6: webhook repetido ---

test("CASO 6: confirmar el mismo pago dos veces descuenta stock una sola vez", () => {
  const store = singleProduct(3)
  reserveStock(store, {
    sessionId: SESSION_A,
    items: [item(2)],
    now: T0,
    ttlMs: TTL,
    orderId: 77,
  })

  const first = consumeOrderReservation(store, 77)
  const second = consumeOrderReservation(store, 77)
  const third = consumeOrderReservation(store, 77)

  assert.equal(first.consumed, true)
  assert.equal(second.consumed, false)
  assert.equal(third.consumed, false)
  assert.equal(store.stock.get("1::"), 1)
})

// --- CASO 7: reintentos / misma sesión ---

test("CASO 7: la misma sesión reintentando no acumula reservas ni consume stock de más", () => {
  const store = singleProduct(2)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = reserveStock(store, {
      sessionId: SESSION_A,
      items: [item(2)],
      now: T0 + attempt,
      ttlMs: TTL,
    })
    assert.equal(result.ok, true)
  }

  assert.equal(store.reservations.length, 1)
  assert.equal(store.reservations[0].quantity, 2)
  assert.equal(getAvailableForSession(store, { productId: 1 }, SESSION_B, T0), 0)
})

// --- CASO 8: cambio de cantidad ---

test("CASO 8: bajar la cantidad libera unidades y subirla las vuelve a tomar", () => {
  const store = singleProduct(5)

  reserveStock(store, { sessionId: SESSION_A, items: [item(4)], now: T0, ttlMs: TTL })
  assert.equal(getAvailableForSession(store, { productId: 1 }, SESSION_B, T0), 1)

  reserveStock(store, { sessionId: SESSION_A, items: [item(1)], now: T0, ttlMs: TTL })
  assert.equal(getAvailableForSession(store, { productId: 1 }, SESSION_B, T0), 4)

  reserveStock(store, { sessionId: SESSION_A, items: [item(5)], now: T0, ttlMs: TTL })
  assert.equal(getAvailableForSession(store, { productId: 1 }, SESSION_B, T0), 0)
})

test("CASO 8b: si la cantidad nueva no entra, la reserva anterior queda intacta", () => {
  const store = createStore([{ productId: 1, stock: 3 }])

  reserveStock(store, { sessionId: SESSION_A, items: [item(2)], now: T0, ttlMs: TTL })
  reserveStock(store, { sessionId: SESSION_B, items: [item(1)], now: T0, ttlMs: TTL })

  const failed = reserveStock(store, {
    sessionId: SESSION_A,
    items: [item(3)],
    now: T0,
    ttlMs: TTL,
  })

  assert.equal(failed.ok, false)
  // Rollback completo: A conserva sus 2 unidades y B las suyas.
  assert.equal(store.reservations.length, 2)
  assert.equal(
    store.reservations.find((entry) => entry.sessionId === SESSION_A)?.quantity,
    2,
  )
  assert.equal(getAvailableForSession(store, { productId: 1 }, SESSION_B, T0), 1)
})

// --- CASO 9: cambio de variante ---

test("CASO 9: cambiar de variante libera la anterior y reserva la nueva, sin reservas fantasma", () => {
  const store = createStore([
    { productId: 1, variantId: 10, stock: 1 },
    { productId: 1, variantId: 11, stock: 1 },
  ])

  reserveStock(store, { sessionId: SESSION_A, items: [item(1, 10)], now: T0, ttlMs: TTL })
  reserveStock(store, { sessionId: SESSION_A, items: [item(1, 11)], now: T0, ttlMs: TTL })

  assert.equal(store.reservations.length, 1)
  assert.equal(store.reservations[0].variantId, 11)
  // La variante 10 volvió a estar disponible para otro checkout...
  assert.equal(
    getAvailableForSession(store, { productId: 1, variantId: 10 }, SESSION_B, T0),
    1,
  )
  // ...y la 11 quedó tomada.
  assert.equal(
    getAvailableForSession(store, { productId: 1, variantId: 11 }, SESSION_B, T0),
    0,
  )
})

test("CASO 9b: liberar la reserva de una sesión nunca toca la de otra", () => {
  const store = singleProduct(2)

  reserveStock(store, { sessionId: SESSION_A, items: [item(1)], now: T0, ttlMs: TTL })
  reserveStock(store, { sessionId: SESSION_B, items: [item(1)], now: T0, ttlMs: TTL })
  releaseSessionReservations(store, SESSION_A)

  assert.equal(store.reservations.length, 1)
  assert.equal(store.reservations[0].sessionId, SESSION_B)
})

// --- CASO 10: pago con reserva vencida ---

test("CASO 10: un pago con reserva vencida sólo se confirma si todavía queda stock", () => {
  const store = singleProduct(1)

  reserveStock(store, {
    sessionId: SESSION_A,
    items: [item(1)],
    now: T0,
    ttlMs: TTL,
    orderId: 90,
  })

  const afterExpiry = T0 + TTL + 1
  // Otra sesión se llevó la unidad después de que venciera la reserva de A.
  reserveStock(store, {
    sessionId: SESSION_B,
    items: [item(1)],
    now: afterExpiry,
    ttlMs: TTL,
    orderId: 91,
  })
  assert.equal(consumeOrderReservation(store, 91).consumed, true)

  // El pago de A llega tarde: no hay stock y la confirmación se rechaza de
  // forma explícita en vez de dejar stock negativo.
  assert.equal(canConfirmOrder(store, [item(1)], afterExpiry + 1), false)
  assert.equal(consumeOrderReservation(store, 90).consumed, false)
  assert.equal(store.stock.get("1::"), 0)
})

test("CASO 10b: mientras la reserva sigue viva, el pago se confirma sin depender de otros", () => {
  const store = singleProduct(1)

  reserveStock(store, {
    sessionId: SESSION_A,
    items: [item(1)],
    now: T0,
    ttlMs: TTL,
    orderId: 92,
  })

  assert.equal(canConfirmOrder(store, [item(1)], T0 + 1000), true)
  assert.equal(consumeOrderReservation(store, 92).consumed, true)
  assert.equal(store.stock.get("1::"), 0)
})

// --- Contrato con la migración: el modelo no puede divergir del SQL real ---

const RESERVATION_MIGRATION = readFileSync(
  "supabase/migrations/20260903150000_checkout_stock_reservation_window.sql",
  "utf8",
)

test("la migración toma advisory lock por producto antes de decidir disponibilidad", () => {
  assert.match(RESERVATION_MIGRATION, /pg_advisory_xact_lock\(93000, v_product_id::integer\)/)
  // Orden ascendente de product_id: sin esto dos checkouts con los mismos dos
  // productos en distinto orden podrían deadlockear.
  assert.match(RESERVATION_MIGRATION, /order by 1\s*\n\s*loop/)
})

test("la disponibilidad descuenta reservas ACTIVAS de otras sesiones, no las propias", () => {
  assert.match(
    RESERVATION_MIGRATION,
    /reservations\.session_id is distinct from p_session_id/,
  )
  assert.match(RESERVATION_MIGRATION, /reservations\.expires_at > now\(\)/)
})

test("validate_checkout_inventory_reservation exige sesión: ya no existe el camino sin reserva", () => {
  assert.match(
    RESERVATION_MIGRATION,
    /length\(btrim\(coalesce\(p_session_id, ''\)\)\) < 8/,
  )
  assert.doesNotMatch(RESERVATION_MIGRATION, /p_session_id is not null\s+and v_reserved_self/)
})

test("cada reserva se reemplaza por completo antes de reinsertar (sin reservas fantasma)", () => {
  assert.match(
    RESERVATION_MIGRATION,
    /delete from public\.stock_reservations reservations\s*\n\s*where reservations\.session_id = p_session_id;/,
  )
})

test("la ventana de reserva sale de una única función y no está hardcodeada por llamada", () => {
  assert.match(RESERVATION_MIGRATION, /create or replace function public\.checkout_reservation_ttl\(\)/)
  assert.match(RESERVATION_MIGRATION, /now\(\) \+ public\.checkout_reservation_ttl\(\)/)
  assert.doesNotMatch(RESERVATION_MIGRATION, /now\(\) \+ interval '\d+ minutes'/)
})

test("la reserva NUNCA decrementa stock físico: expirar no puede inventar unidades", () => {
  assert.doesNotMatch(
    RESERVATION_MIGRATION,
    /update public\.(productos|producto_variantes)\s+set stock/i,
  )
})

test("la ventana de reserva coincide EXACTAMENTE con la ventana de pago de Mercado Pago", () => {
  // INVARIANTE en las dos direcciones:
  //   - si la reserva venciera ANTES que la preferencia, otro cliente podría
  //     llevarse la unidad y el primer pago quedaría aprobado sin poder
  //     confirmarse (ver approved_stock_conflict);
  //   - si la reserva durara MÁS que la preferencia, el inventario queda
  //     gravado innecesariamente después de que ese intento de pago ya no
  //     puede completarse.
  // No hay una única fuente en runtime (una vive en SQL, la otra en TS), así
  // que este test es la fuente de verdad que impide que diverjan: cualquier
  // cambio a uno de los dos valores sin tocar el otro rompe la suite.
  const ttlMinutes = Number(
    /checkout_reservation_ttl\(\)[\s\S]*?select interval '(\d+) minutes'/.exec(
      RESERVATION_MIGRATION,
    )?.[1],
  )
  const preferenceMinutes = Number(
    /MERCADOPAGO_PREFERENCE_LIFETIME_MINUTES = (\d+)/.exec(
      readFileSync("lib/mercadopago/checkout-attempt.ts", "utf8"),
    )?.[1],
  )

  assert.ok(Number.isInteger(ttlMinutes) && ttlMinutes > 0)
  assert.ok(Number.isInteger(preferenceMinutes) && preferenceMinutes > 0)
  assert.equal(
    ttlMinutes,
    preferenceMinutes,
    `la reserva dura ${ttlMinutes} min y la preferencia ${preferenceMinutes} min -- deben ser iguales`,
  )
})

// --- Endurecimiento de seguridad agregado sobre la migración ---

test("reserve_cart_stock rechaza payloads con más de 50 líneas (tope anti-DoS)", () => {
  assert.match(RESERVATION_MIGRATION, /jsonb_array_length\(p_items\) > 50/)
})

test("una cantidad negativa u cero en CUALQUIER línea cruda se rechaza antes de agrupar", () => {
  // La agregación por producto/variante SUMA cantidades: una línea negativa
  // podría compensarse con otra positiva y esconderse detrás de un total
  // agregado que parece válido. El chequeo tiene que correr sobre las líneas
  // crudas, antes del group by.
  const matches = [
    ...RESERVATION_MIGRATION.matchAll(
      /from jsonb_array_elements\(p_items\) item\s*\n\s*where coalesce\(nullif\(item ->> 'quantity', ''\)::integer, 0\) <= 0/g,
    ),
  ]
  // Una vez en reserve_cart_stock y otra en validate_checkout_inventory_reservation.
  assert.equal(matches.length, 2)
})

test("reserve_cart_stock rechaza pisar la reserva activa de OTRO usuario autenticado por el mismo session_id", () => {
  assert.match(RESERVATION_MIGRATION, /RESERVATION_SESSION_MISMATCH/)
  assert.match(
    RESERVATION_MIGRATION,
    /reservations\.user_id is not null\s*\n\s*and reservations\.user_id is distinct from auth\.uid\(\)/,
  )
})

test("validate_checkout_inventory_reservation compara la sesión contra el dueño real de la orden, no auth.uid()", () => {
  // Esta función corre con el service role (sin JWT de usuario): auth.uid()
  // no identifica a nadie acá, así que la comparación tiene que salir de
  // ordenes.usuario_id para el pedido que se está confirmando.
  assert.match(RESERVATION_MIGRATION, /select orders\.usuario_id into v_order_user_id/)
  assert.match(
    RESERVATION_MIGRATION,
    /reservations\.user_id is not null\s*\n\s*and reservations\.user_id is distinct from v_order_user_id/,
  )
})

test("la reserva creada al confirmar la orden guarda el dueño real, nunca lo pisa con null", () => {
  // Insertar siempre user_id=null debilitaría el chequeo de propiedad que ya
  // usan release_cart_stock_reservation/complete_cart_stock_reservation
  // (`user_id is null or user_id = auth.uid()`) para una orden que sí tiene
  // usuario autenticado -- cualquiera con el session_id podría liberarla.
  assert.match(
    RESERVATION_MIGRATION,
    /values \(\s*\n\s*p_session_id, v_order_user_id, v_item\.product_id, v_item\.variant_id,/,
  )
  assert.doesNotMatch(
    RESERVATION_MIGRATION,
    /values \(\s*\n\s*p_session_id, null, v_item\.product_id,/,
  )
})

test("la limpieza de vencidas es idempotente y está aislada en su propia función", () => {
  assert.match(
    RESERVATION_MIGRATION,
    /create or replace function public\.purge_expired_stock_reservations\(\)/,
  )
  assert.match(
    RESERVATION_MIGRATION,
    /delete from public\.stock_reservations reservations\s*\n\s*where reservations\.expires_at <= now\(\);/,
  )
})
