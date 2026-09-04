/**
 * Modelo de referencia (puro, en memoria) del algoritmo de reserva de stock
 * del checkout.
 *
 * La FUENTE DE VERDAD es la función SQL
 * `validate_checkout_inventory_reservation`
 * (supabase/migrations/20260903150000_checkout_stock_reservation_window.sql).
 * Este módulo existe para poder ejercitar las reglas de concurrencia --
 * quién gana la última unidad, qué pasa al vencer una reserva, qué pasa al
 * cambiar el carrito -- sin una base de datos, y `stock-reservation-model.test.ts`
 * verifica además que la migración siga implementando las mismas reglas.
 *
 * Reglas modeladas (idénticas a la migración):
 *
 * 1. El stock físico NO se decrementa al reservar. La reserva es un gravamen
 *    temporal; el stock real sigue saliendo del libro derivado de movimientos.
 * 2. Disponible para una sesión = stock - reservas ACTIVAS de OTRAS sesiones.
 *    La sesión no se descuenta a sí misma.
 * 3. `reserve` reemplaza íntegramente lo reservado por esa sesión (borra todo
 *    lo suyo y vuelve a insertar). Por eso es idempotente ante reintentos y
 *    no deja reservas fantasma cuando cambia cantidad, producto o variante.
 * 4. Todo el ciclo leer-decidir-escribir es atómico: en la base lo garantiza
 *    `pg_advisory_xact_lock` por producto dentro de una única transacción;
 *    acá lo garantiza que sea una función síncrona.
 * 5. Expirar es idempotente: sólo deja de contar reservas vencidas, nunca
 *    "devuelve" stock (porque nunca lo restó).
 */

export interface StockReservationTarget {
  productId: number
  variantId?: number | null
  conditionedStockId?: string | null
}

export interface StockReservationRequestItem extends StockReservationTarget {
  quantity: number
}

export interface StockReservationRecord extends StockReservationRequestItem {
  sessionId: string
  orderId: number | null
  expiresAt: number
}

export interface StockReservationStore {
  /** Stock derivado por objetivo (producto/variante/condicionado). */
  stock: Map<string, number>
  reservations: StockReservationRecord[]
}

export type ReserveResult =
  | { ok: true; expiresAt: number; reserved: StockReservationRecord[] }
  | { ok: false; reason: "insufficient_stock" | "invalid_request" }

export function targetKey(target: StockReservationTarget) {
  return [
    target.productId,
    target.variantId ?? "",
    target.conditionedStockId ?? "",
  ].join(":")
}

export function createStore(
  stock: Array<StockReservationTarget & { stock: number }>,
): StockReservationStore {
  return {
    stock: new Map(stock.map((entry) => [targetKey(entry), entry.stock])),
    reservations: [],
  }
}

/** Regla 5: borrar lo vencido no suma stock; ejecutarlo N veces da lo mismo. */
export function purgeExpiredReservations(
  store: StockReservationStore,
  now: number,
) {
  const before = store.reservations.length
  store.reservations = store.reservations.filter(
    (reservation) => reservation.expiresAt > now,
  )
  return before - store.reservations.length
}

/** Regla 2: disponible para `sessionId` = stock - reservas activas ajenas. */
export function getAvailableForSession(
  store: StockReservationStore,
  target: StockReservationTarget,
  sessionId: string | null,
  now: number,
): number | null {
  const key = targetKey(target)
  if (!store.stock.has(key)) return null

  const reservedByOthers = store.reservations
    .filter(
      (reservation) =>
        targetKey(reservation) === key &&
        reservation.expiresAt > now &&
        (sessionId === null || reservation.sessionId !== sessionId),
    )
    .reduce((total, reservation) => total + reservation.quantity, 0)

  return (store.stock.get(key) ?? 0) - reservedByOthers
}

function groupItems(items: StockReservationRequestItem[]) {
  const grouped = new Map<string, StockReservationRequestItem>()

  for (const item of items) {
    const key = targetKey(item)
    const existing = grouped.get(key)
    if (existing) {
      existing.quantity += item.quantity
      continue
    }
    grouped.set(key, { ...item })
  }

  return [...grouped.values()].sort((left, right) =>
    targetKey(left).localeCompare(targetKey(right)),
  )
}

export interface ReserveOptions {
  sessionId: string
  items: StockReservationRequestItem[]
  now: number
  ttlMs: number
  orderId?: number | null
}

/**
 * Regla 3 + 4: operación atómica que reemplaza la reserva completa de la
 * sesión. O queda TODO el carrito reservado, o no cambia nada.
 */
export function reserveStock(
  store: StockReservationStore,
  { sessionId, items, now, ttlMs, orderId = null }: ReserveOptions,
): ReserveResult {
  if (!sessionId || items.length === 0) {
    return { ok: false, reason: "invalid_request" }
  }
  if (items.some((item) => !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    return { ok: false, reason: "invalid_request" }
  }

  purgeExpiredReservations(store, now)

  const requested = groupItems(items)
  const expiresAt = now + ttlMs
  // Snapshot previo: si algún ítem no entra, la operación entera se descarta
  // y la reserva anterior de la sesión queda intacta (rollback).
  const previous = store.reservations
  const withoutSession = previous.filter(
    (reservation) => reservation.sessionId !== sessionId,
  )
  store.reservations = withoutSession

  const created: StockReservationRecord[] = []

  for (const item of requested) {
    const available = getAvailableForSession(store, item, sessionId, now)

    if (available === null || available < item.quantity) {
      store.reservations = previous
      return { ok: false, reason: "insufficient_stock" }
    }

    const record: StockReservationRecord = {
      ...item,
      sessionId,
      orderId,
      expiresAt,
    }
    created.push(record)
    store.reservations = [...store.reservations, record]
  }

  return { ok: true, expiresAt, reserved: created }
}

/** Libera todo lo reservado por una sesión (cambio de método de pago, error, etc.). */
export function releaseSessionReservations(
  store: StockReservationStore,
  sessionId: string,
) {
  store.reservations = store.reservations.filter(
    (reservation) => reservation.sessionId !== sessionId,
  )
}

/**
 * Consumo por pago confirmado. En la base equivale a: la orden pasa a un
 * estado que consume stock -> el libro derivado incorpora la venta desde
 * `orden_items` y el trigger borra la reserva de esa orden.
 *
 * Es idempotente: consumir dos veces la misma orden (webhook repetido, retry,
 * dos confirmaciones simultáneas) descuenta una sola vez, porque la segunda
 * ya no encuentra reserva viva para esa orden.
 */
export function consumeOrderReservation(
  store: StockReservationStore,
  orderId: number,
): { consumed: boolean } {
  const orderReservations = store.reservations.filter(
    (reservation) => reservation.orderId === orderId,
  )

  if (orderReservations.length === 0) return { consumed: false }

  for (const reservation of orderReservations) {
    const key = targetKey(reservation)
    store.stock.set(key, (store.stock.get(key) ?? 0) - reservation.quantity)
  }

  store.reservations = store.reservations.filter(
    (reservation) => reservation.orderId !== orderId,
  )

  return { consumed: true }
}

/**
 * Guardián de confirmación: equivale a `validate_inventory_order_confirmation`.
 * Un pago aprobado cuya reserva ya venció sólo puede confirmarse si todavía
 * queda stock; si no, se rechaza explícitamente (no se confirma con stock
 * negativo ni se descarta el pago en silencio).
 */
export function canConfirmOrder(
  store: StockReservationStore,
  items: StockReservationRequestItem[],
  now: number,
): boolean {
  purgeExpiredReservations(store, now)

  return groupItems(items).every((item) => {
    const key = targetKey(item)
    if (!store.stock.has(key)) return false
    return (store.stock.get(key) ?? 0) >= item.quantity
  })
}
