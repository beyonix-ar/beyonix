import assert from "node:assert/strict"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import {
  ANDREANI_ORDER,
  LOCAL_ORDER,
  LOCAL_SINGLE,
  localDeliveryOutcomeSetupSql,
  OUTCOME_ACTOR as actor,
  OUTCOME_CUSTOMER,
  OUTCOME_PICK_CODES,
  OUTCOME_SEED_SQL,
  outcomeToken,
} from "./fixtures/local-delivery-outcome-db.ts"

// Resultado de la entrega Envío BEYONIX (20261105120000) contra las migraciones
// reales: token del QR, intentos, incidencia, Entregado canónico, retorno
// físico con picking inverso, reserva con vencimiento a las 00:00 y liberación
// de stock por el libro de inventario. Andreani nunca participa.

let requestNumber = 0
const key = () => `93000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`
const RESERVATION_DAYS = 3

async function setup() {
  const db = new PGlite()
  for (const sql of localDeliveryOutcomeSetupSql()) await db.exec(sql)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.exec(OUTCOME_SEED_SQL)
  return db
}

type Row = Record<string, unknown>
const one = async <T extends Row>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]

async function prepare(db: PGlite, orderId: number, parcelCount: number) {
  await db.query("select begin_order_preparation($1,$2)", [orderId, actor])
  for (const code of OUTCOME_PICK_CODES[orderId]) await db.query("select scan_order_preparation_code($1,$2,$3,$4)", [orderId, code, actor, key()])
  await db.query("select set_order_package_parcels($1,$2,$3,$4)", [orderId, parcelCount, actor, key()])
  const codes = (await db.query<{ barcode: string }>("select barcode from order_package_parcels where order_id=$1 order by parcel_index", [orderId])).rows.map((row) => row.barcode)
  for (const code of codes) await db.query("select confirm_local_delivery_parcel($1,$2,$3)", [orderId, code, actor])
  return codes
}

const ensure = (db: PGlite, orderId: number, token = outcomeToken(orderId)) =>
  one<{ token: string }>(db, "select ensure_local_delivery_shipment($1,$2,$3) token", [orderId, actor, token])
const outcome = (db: PGlite, token: string, kind: "absent" | "incident", expected: number, reason: string | null = null, comment: string | null = null) =>
  one<{ result: { result: string; changed: boolean; outcomeStatus: string; failedAttempts: number } }>(
    db, "select record_local_delivery_courier_outcome($1,$2,$3,$4,$5) result", [token, kind, expected, reason, comment]).then((row) => row.result)
const shipment = (db: PGlite, orderId: number) =>
  one<{ outcome_status: string; failed_attempts: number; incident_reason: string | null; returning_at: string | null; returned_at: string | null; delivered_at: string | null }>(
    db, "select * from local_delivery_shipments where order_id=$1", [orderId])
const estado = async (db: PGlite, orderId: number) => (await one<{ estado: string }>(db, "select estado from ordenes where id=$1", [orderId])).estado
const audits = async (db: PGlite, orderId: number, action: string) =>
  (await one<{ count: number }>(db, "select count(*)::int count from order_audit_events where order_id=$1 and action=$2", [orderId, action])).count
const receive = (db: PGlite, code: string, days = RESERVATION_DAYS) =>
  one<{ result: { orderId: number; received: number; parcelCount: number; complete: boolean; completedNow: boolean; duplicate: boolean; reservationExpiresAt: string | null } }>(
    db, "select receive_local_delivery_return_parcel($1,$2,$3) result", [code, actor, days]).then((row) => row.result)
const stock = async (db: PGlite) => {
  const product = await one<{ a: number; b: number }>(db, "select (select stock from productos where id=1)::int a, (select stock from productos where id=2)::int b")
  const variant = await one<{ red: number }>(db, "select stock::int red from producto_variantes where id=11")
  return { productA: product.a, productB: product.b, red: variant.red }
}

/** Pedido local de 2 bultos, etiquetas confirmadas, QR emitido y En camino. */
async function inTransit(db: PGlite, orderId = LOCAL_ORDER, parcels = 2) {
  const codes = await prepare(db, orderId, parcels)
  const { token } = await ensure(db, orderId)
  await db.query("update ordenes set estado='en_camino' where id=$1", [orderId])
  return { codes, token }
}

async function returning(db: PGlite) {
  const ctx = await inTransit(db)
  await outcome(db, ctx.token, "absent", 0)
  await outcome(db, ctx.token, "absent", 1)
  return ctx
}

test("vencimiento: días calendario completos y 00:00 hora de BEYONIX (no recepción + 72 h)", async () => {
  const db = await setup()
  const expiry = async (at: string, days: number) => (await one<{ value: string }>(db,
    "select to_char(local_delivery_reservation_expiry($1::timestamptz,$2) at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI') value", [at, days])).value
  // 5/11 15:30 (-03) con 3 días → cubre 6, 7 y 8/11 y vence el 09/11 00:00 (-03) = 03:00 UTC.
  assert.equal(await expiry("2026-11-05T15:30:00-03:00", 3), "2026-11-09T03:00")
  // 23:59 del 5/11 sigue siendo el 5/11 en Argentina aunque en UTC ya sea el 6.
  assert.equal(await expiry("2026-11-06T02:59:00Z", 3), "2026-11-09T03:00")
  assert.equal(await expiry("2026-11-06T03:00:00Z", 3), "2026-11-10T03:00", "00:00 del 6/11 en Argentina")
  assert.equal(await expiry("2026-11-05T15:30:00-03:00", 1), "2026-11-07T03:00")
  assert.equal(await expiry("2026-12-30T10:00:00-03:00", 5), "2027-01-05T03:00", "cruza el año")
})

test("token del QR: sólo Despachos lo emite; reimprimir devuelve el mismo; Andreani o cancelado nunca", async () => {
  const db = await setup()
  await prepare(db, LOCAL_ORDER, 2)
  const first = await ensure(db, LOCAL_ORDER)
  assert.equal(first.token, outcomeToken(LOCAL_ORDER))
  const again = await ensure(db, LOCAL_ORDER, "otroTokenTotalmenteNuevo123")
  assert.equal(again.token, first.token, "reimpresión: mismo QR para todos los bultos")
  assert.equal((await one<{ count: number }>(db, "select count(*)::int count from local_delivery_shipments where order_id=$1", [LOCAL_ORDER])).count, 1)
  await assert.rejects(ensure(db, LOCAL_SINGLE, "corto"), /LOCAL_DELIVERY_TOKEN_INVALID/)
  await assert.rejects(ensure(db, LOCAL_SINGLE, "token con espacios no vale"), /LOCAL_DELIVERY_TOKEN_INVALID|check/)
  await assert.rejects(ensure(db, ANDREANI_ORDER), /DISPATCH_LOCAL_DELIVERY_ONLY/)
  await assert.rejects(db.query("select ensure_local_delivery_shipment($1,$2,$3)", [LOCAL_SINGLE, OUTCOME_CUSTOMER, outcomeToken(LOCAL_SINGLE)]), /DISPATCH/)
  await db.query("update ordenes set estado='cancelado', cancelled_at=now() where id=$1", [LOCAL_SINGLE])
  await assert.rejects(ensure(db, LOCAL_SINGLE), /LOCAL_DELIVERY_LABEL_ORDER_CANCELLED/)
  // Un token revocado se rota sobre la MISMA entrega.
  await db.query("update local_delivery_shipments set token_revoked_at=now() where order_id=$1", [LOCAL_ORDER])
  const rotated = await ensure(db, LOCAL_ORDER, "rotadoTokenNuevoParaQR99")
  assert.equal(rotated.token, "rotadoTokenNuevoParaQR99")
  assert.equal((await one<{ count: number }>(db, "select count(*)::int count from local_delivery_shipments where order_id=$1", [LOCAL_ORDER])).count, 1)
})

test("intentos: 1.er ausente queda pendiente de 2.º intento; un doble toque no cuenta dos veces; el 2.º vuelve a BEYONIX; no hay 3.º", async () => {
  const db = await setup()
  const { token } = await inTransit(db)
  const first = await outcome(db, token, "absent", 0)
  assert.deepEqual([first.result, first.changed, first.outcomeStatus, first.failedAttempts], ["first_attempt_failed", true, "first_attempt_failed", 1])
  const doubleTap = await outcome(db, token, "absent", 0)
  assert.deepEqual([doubleTap.result, doubleTap.changed, doubleTap.failedAttempts], ["unchanged", false, 1], "el segundo toque del mismo intento no avanza")
  assert.equal(await estado(db, LOCAL_ORDER), "en_camino", "sigue asignado al cadete, sin estados Andreani")
  const second = await outcome(db, token, "absent", 1)
  assert.deepEqual([second.result, second.outcomeStatus, second.failedAttempts], ["returning", "returning", 2])
  // Tercer "Cliente ausente": rechazado explícitamente (la app responde 409), con cualquier contador.
  for (const expected of [2, 1, 0]) {
    const third = await outcome(db, token, "absent", expected)
    assert.deepEqual([third.result, third.changed, third.failedAttempts], ["max_attempts", false, 2], `no existe un tercer intento (${expected})`)
  }
  assert.equal(await estado(db, LOCAL_ORDER), "en_camino")
  assert.equal(await audits(db, LOCAL_ORDER, "local_delivery_attempt_failed"), 2)
  assert.equal(await audits(db, LOCAL_ORDER, "local_delivery_return_started"), 1)
  const row = await shipment(db, LOCAL_ORDER)
  assert.ok(row.returning_at)
  // El cadete tampoco puede reportar un problema ni entregar algo que vuelve.
  assert.equal((await outcome(db, token, "incident", 2, "no_access")).result, "unchanged")
  assert.equal((await db.query("select * from mark_local_delivery_delivered_by_courier($1)", [token])).rows.length, 0)
})

test("Entregado: el cadete usa la misma transición; Admin no puede entregar un pedido que vuelve o volvió", async () => {
  const db = await setup()
  const { token } = await inTransit(db)
  await outcome(db, token, "absent", 0)
  const delivered = await db.query<{ estado: string; delivered_at: string }>("select * from mark_local_delivery_delivered_by_courier($1)", [token])
  assert.equal(delivered.rows[0].estado, "entregado")
  assert.ok(delivered.rows[0].delivered_at)
  assert.equal((await shipment(db, LOCAL_ORDER)).outcome_status, "delivered", "el resultado se sincroniza en la misma transacción")
  assert.equal((await db.query("select * from mark_local_delivery_delivered_by_courier($1)", [token])).rows.length, 0, "repetir no vuelve a escribir")
  assert.equal((await outcome(db, token, "absent", 1)).result, "already_delivered")

  // Otro pedido: vuelve a BEYONIX → la guarda frena cualquier UPDATE a entregado.
  const other = await setup()
  await returning(other)
  await assert.rejects(other.query("update ordenes set estado='entregado', delivered_at=now() where id=$1", [LOCAL_ORDER]), /LOCAL_DELIVERY_RETURN_IN_PROGRESS/)
  // Andreani no se ve afectado por la guarda.
  await other.query("update ordenes set estado='entregado' where id=$1", [ANDREANI_ORDER])
})

test("Entregado: el cadete no entrega sin pago confirmado, con cambio pendiente o antes de salir", async () => {
  const db = await setup()
  await prepare(db, LOCAL_ORDER, 2)
  const { token } = await ensure(db, LOCAL_ORDER)
  assert.equal((await db.query("select * from mark_local_delivery_delivered_by_courier($1)", [token])).rows.length, 0, "todavía Preparando")
  assert.equal((await outcome(db, token, "absent", 0)).result, "not_in_transit")
  await db.query("update ordenes set estado='en_camino' where id=$1", [LOCAL_ORDER])
  await db.query("update ordenes set order_change_status='change_requested' where id=$1", [LOCAL_ORDER])
  assert.equal((await db.query("select * from mark_local_delivery_delivered_by_courier($1)", [token])).rows.length, 0)
  await db.query("update ordenes set order_change_status=null, financial_status='refund_pending' where id=$1", [LOCAL_ORDER])
  assert.equal((await db.query("select * from mark_local_delivery_delivered_by_courier($1)", [token])).rows.length, 0)
  assert.equal((await outcome(db, token, "absent", 0)).result, "cancelled")
  await assert.rejects(outcome(db, "noExisteEsteTokenEnLaBase1", "absent", 0), /LOCAL_DELIVERY_TOKEN_INVALID/)
  await assert.rejects(outcome(db, "x';drop table ordenes;--", "absent", 0), /LOCAL_DELIVERY_TOKEN_INVALID/)
})

test("problema con la entrega: opciones sin comentario; 'Otro' lo exige; Admin reintenta o trae el pedido de vuelta", async () => {
  const db = await setup()
  const { token } = await inTransit(db)
  await assert.rejects(outcome(db, token, "incident", 0, "other", "  "), /LOCAL_DELIVERY_COMMENT_REQUIRED/)
  await assert.rejects(outcome(db, token, "incident", 0, "inventado"), /LOCAL_DELIVERY_OUTCOME_INVALID/)
  await assert.rejects(outcome(db, token, "incident", 0, "other", "x".repeat(281)), /LOCAL_DELIVERY_OUTCOME_INVALID/)
  const reported = await outcome(db, token, "incident", 0, "wrong_address")
  assert.deepEqual([reported.result, reported.outcomeStatus], ["incident", "incident"])
  assert.equal(await estado(db, LOCAL_ORDER), "en_camino", "no marca Entregado")
  assert.equal((await outcome(db, token, "absent", 0)).result, "unchanged", "con la incidencia abierta el cadete espera a Admin")
  assert.equal((await db.query("select * from mark_local_delivery_delivered_by_courier($1)", [token])).rows.length, 0)

  await db.query("select resolve_local_delivery_incident($1,$2,'retry')", [LOCAL_ORDER, actor])
  assert.deepEqual([(await shipment(db, LOCAL_ORDER)).outcome_status, (await shipment(db, LOCAL_ORDER)).incident_reason], ["pending", null])
  await outcome(db, token, "absent", 0)
  await outcome(db, token, "incident", 1, "other", "Portón con candado, nadie atiende")
  await db.query("select resolve_local_delivery_incident($1,$2,'retry')", [LOCAL_ORDER, actor])
  assert.equal((await shipment(db, LOCAL_ORDER)).outcome_status, "first_attempt_failed", "conserva el intento fallido anterior")
  await outcome(db, token, "incident", 1, "rejected")
  await assert.rejects(db.query("select resolve_local_delivery_incident($1,$2,'retry')", [LOCAL_ORDER, OUTCOME_CUSTOMER]), /DISPATCH/)
  await db.query("select resolve_local_delivery_incident($1,$2,'return')", [LOCAL_ORDER, actor])
  assert.equal((await shipment(db, LOCAL_ORDER)).outcome_status, "returning")
  await assert.rejects(db.query("select resolve_local_delivery_incident($1,$2,'return')", [LOCAL_ORDER, actor]), /LOCAL_DELIVERY_STATE_CHANGED/)
  assert.equal(await audits(db, LOCAL_ORDER, "local_delivery_incident_reported"), 3)

  // Admin también puede cerrar una incidencia como entregada (acción canónica).
  const other = await setup()
  const second = await inTransit(other)
  await outcome(other, second.token, "incident", 0, "no_access")
  await other.query("update ordenes set estado='entregado', delivered_at=now() where id=$1", [LOCAL_ORDER])
  assert.equal((await shipment(other, LOCAL_ORDER)).outcome_status, "delivered")
})

test("recepción: parcial no cierra ni reserva; duplicado idempotente; con todos los bultos → Devuelto + reserva", async () => {
  const db = await setup()
  const { codes } = await returning(db)
  const before = await stock(db)
  await assert.rejects(receive(db, "BAR-A-RED"), /DISPATCH_LOCAL_PARCEL_CODE_REQUIRED/)
  await assert.rejects(receive(db, "BX-PKG-9999-01"), /DISPATCH_PARCEL_UNKNOWN/)
  await assert.rejects(receive(db, codes[0], 0), /LOCAL_DELIVERY_RESERVATION_DAYS_INVALID/)
  await assert.rejects(receive(db, codes[0], 31), /LOCAL_DELIVERY_RESERVATION_DAYS_INVALID/)

  const partial = await receive(db, codes[0].toLowerCase())
  assert.deepEqual([partial.received, partial.parcelCount, partial.complete, partial.duplicate], [1, 2, false, false])
  assert.equal((await receive(db, codes[0])).duplicate, true)
  assert.equal((await shipment(db, LOCAL_ORDER)).outcome_status, "returning", "recepción incompleta: 1 de 2")
  assert.equal((await one<{ count: number }>(db, "select count(*)::int count from local_delivery_return_reservations")).count, 0)
  assert.deepEqual(await stock(db), before, "no libera ni reserva stock con un faltante")

  const complete = await receive(db, codes[1])
  assert.deepEqual([complete.received, complete.complete, complete.completedNow], [2, true, true])
  const row = await shipment(db, LOCAL_ORDER)
  assert.equal(row.outcome_status, "returned")
  assert.ok(row.returned_at)
  const reservation = await one<{ status: string; reservation_days: number; expires_at: string; starts_at: string; expected: string }>(db,
    "select status, reservation_days, expires_at, starts_at, local_delivery_reservation_expiry(starts_at, 3) expected from local_delivery_return_reservations where order_id=$1", [LOCAL_ORDER])
  assert.deepEqual([reservation.status, reservation.reservation_days], ["active", 3])
  assert.equal(new Date(reservation.expires_at).toISOString(), new Date(reservation.expected).toISOString())
  const items = (await db.query<{ order_item_id: number; quantity: number }>("select order_item_id::int, quantity from local_delivery_return_reservation_items order by order_item_id")).rows
  assert.deepEqual(items.map((item) => [item.order_item_id, item.quantity]), [[1, 2], [2, 1]])
  assert.deepEqual(await stock(db), before, "reservado = sigue apartado para el pedido, no vuelve a la venta")
  // Re-escanear después de cerrar es idempotente y no crea otra reserva.
  assert.equal((await receive(db, codes[1])).duplicate, true)
  assert.equal((await one<{ count: number }>(db, "select count(*)::int count from local_delivery_return_reservations")).count, 1)
  assert.equal(await audits(db, LOCAL_ORDER, "local_delivery_return_parcel_received"), 2)
  assert.equal(await audits(db, LOCAL_ORDER, "local_delivery_return_received"), 1)
  assert.equal(await audits(db, LOCAL_ORDER, "local_delivery_return_reservation_started"), 1)
  await assert.rejects(db.query("update ordenes set estado='entregado' where id=$1", [LOCAL_ORDER]), /LOCAL_DELIVERY_RETURN_IN_PROGRESS/)
})

test("recepción: sólo pedidos que vuelven y sólo bultos del intento que salió", async () => {
  const db = await setup()
  const { codes } = await inTransit(db)
  await assert.rejects(receive(db, codes[0]), (error: Error & { detail?: string }) =>
    /LOCAL_DELIVERY_RETURN_NOT_EXPECTED/.test(error.message) && error.detail === String(LOCAL_ORDER))
  await assert.rejects(db.query("select receive_local_delivery_return_parcel($1,$2,3)", [codes[0], OUTCOME_CUSTOMER]), /DISPATCH/)
})

test("configuración: la reserva congela los días y el vencimiento con los que empezó", async () => {
  const db = await setup()
  const { codes } = await returning(db)
  await receive(db, codes[0], 5)
  await receive(db, codes[1], 5)
  const started = await one<{ reservation_days: number; expires_at: string }>(db, "select reservation_days, expires_at from local_delivery_return_reservations where order_id=$1", [LOCAL_ORDER])
  assert.equal(started.reservation_days, 5)
  // Un cambio posterior de configuración sólo llega a nuevas recepciones: la fila no se recalcula.
  await receive(db, codes[1], 2)
  const after = await one<{ reservation_days: number; expires_at: string }>(db, "select reservation_days, expires_at from local_delivery_return_reservations where order_id=$1", [LOCAL_ORDER])
  assert.deepEqual(after, started)
})

test("vencimiento: el job libera las unidades una sola vez (idempotente) y lo deja en el libro", async () => {
  const db = await setup()
  const { codes } = await returning(db)
  const sold = await stock(db)
  await receive(db, codes[0])
  await receive(db, codes[1])
  assert.equal((await one<{ result: { expired: number } }>(db, "select expire_local_delivery_return_reservations(100) result")).result.expired, 0, "todavía vigente")
  await db.query("update local_delivery_return_reservations set starts_at=now()-interval '5 days', expires_at=now()-interval '1 minute'")
  const run = await one<{ result: { expired: number; orderIds: number[] } }>(db, "select expire_local_delivery_return_reservations(100) result")
  assert.deepEqual([run.result.expired, run.result.orderIds], [1, [LOCAL_ORDER]])
  assert.deepEqual(await stock(db), { productA: sold.productA + 2, productB: sold.productB + 1, red: sold.red + 2 }, "vuelven al stock vendible")
  assert.equal((await one<{ result: { expired: number } }>(db, "select expire_local_delivery_return_reservations(100) result")).result.expired, 0, "idempotente")
  assert.deepEqual(await stock(db), { productA: sold.productA + 2, productB: sold.productB + 1, red: sold.red + 2 })
  assert.equal(await audits(db, LOCAL_ORDER, "local_delivery_return_reservation_expired"), 1)
  const movement = await one<{ count: number; total: number }>(db,
    "select count(*)::int count, sum(quantity_delta)::int total from inventory_movements where source='local_delivery_return_release'")
  assert.deepEqual([movement.count, movement.total], [2, 3])
  await assert.rejects(db.query("select consume_local_delivery_return_reservation($1,$2)", [LOCAL_ORDER, actor]), /LOCAL_DELIVERY_RESERVATION_NOT_ACTIVE/)

})

test("consumo (nuevo envío): usa las unidades reservadas sin liberarlas; no consume una reserva ya vencida", async () => {
  const db = await setup()
  const { codes } = await returning(db)
  const sold = await stock(db)
  await receive(db, codes[0])
  await receive(db, codes[1])
  const consumed = await one<{ result: { status: string } }>(db, "select consume_local_delivery_return_reservation($1,$2) result", [LOCAL_ORDER, actor])
  assert.equal(consumed.result.status, "consumed")
  assert.deepEqual(await stock(db), sold, "siguen apartadas para el pedido")
  await db.query("update local_delivery_return_reservations set starts_at=now()-interval '5 days', expires_at=now()-interval '1 minute'")
  assert.equal((await one<{ result: { expired: number } }>(db, "select expire_local_delivery_return_reservations(100) result")).result.expired, 0, "consumida no vence")
  assert.equal(await audits(db, LOCAL_ORDER, "local_delivery_return_reservation_consumed"), 1)

  const other = await setup()
  const second = await returning(other)
  await receive(other, second.codes[0])
  await receive(other, second.codes[1])
  await other.query("update local_delivery_return_reservations set starts_at=now()-interval '5 days', expires_at=now()-interval '1 minute'")
  await assert.rejects(other.query("select consume_local_delivery_return_reservation($1,$2)", [LOCAL_ORDER, actor]), /LOCAL_DELIVERY_RESERVATION_EXPIRED/,
    "vencida aunque el job no haya corrido")
})

test("consumo idempotente: repetirlo devuelve la reserva ya consumida sin volver a escribir", async () => {
  const db = await setup()
  const { codes } = await returning(db)
  await receive(db, codes[0])
  await receive(db, codes[1])
  const first = await one<{ result: { status: string; alreadyConsumed: boolean; reservationId: number } }>(db, "select consume_local_delivery_return_reservation($1,$2) result", [LOCAL_ORDER, actor])
  const again = await one<{ result: { status: string; alreadyConsumed: boolean; reservationId: number } }>(db, "select consume_local_delivery_return_reservation($1,$2) result", [LOCAL_ORDER, actor])
  assert.deepEqual([first.result.status, first.result.alreadyConsumed], ["consumed", false])
  assert.deepEqual([again.result.status, again.result.alreadyConsumed, again.result.reservationId], ["consumed", true, first.result.reservationId])
  assert.equal(await audits(db, LOCAL_ORDER, "local_delivery_return_reservation_consumed"), 1, "un solo consumo auditado")
  // Una reserva vencida nunca se "consume" por repetición.
  const other = await setup()
  const second = await returning(other)
  await receive(other, second.codes[0])
  await receive(other, second.codes[1])
  await other.query("update local_delivery_return_reservations set starts_at=now()-interval '5 days', expires_at=now()-interval '1 minute'")
  await other.query("select expire_local_delivery_return_reservations(100)")
  await assert.rejects(other.query("select consume_local_delivery_return_reservation($1,$2)", [LOCAL_ORDER, actor]), /LOCAL_DELIVERY_RESERVATION_NOT_ACTIVE/)
})

test("devuelto y después cancelado: la recepción ya registrada resuelve la retención (sin segundo escaneo); stock 10 → 8 → 8 → 10", async () => {
  const db = await setup()
  // Variante comprada: 10 unidades; el pedido pagado se lleva 2 (8).
  const { codes } = await returning(db)
  const sold = await stock(db)
  const initial = { productA: sold.productA + 2, productB: sold.productB + 1, red: sold.red + 2 }
  assert.deepEqual([initial.red, sold.red], [10, 8], "10 → 8 con el pedido")
  await receive(db, codes[0])
  await receive(db, codes[1])
  assert.deepEqual(await stock(db), sold, "devuelto y reservado: sigue en 8")
  await db.query("update ordenes set estado='cancelado', cancelled_at=now(), payment_status='cancelado' where id=$1", [LOCAL_ORDER])
  assert.equal((await one<{ status: string }>(db, "select status from local_delivery_return_reservations where order_id=$1", [LOCAL_ORDER])).status, "cancelled")
  assert.equal(await audits(db, LOCAL_ORDER, "local_delivery_return_reservation_cancelled"), 1)
  // La cancelación abrió la retención física y la recepción local la resolvió en la misma transacción.
  assert.equal((await one<{ value: boolean }>(db, "select order_has_active_stock_hold($1) value", [LOCAL_ORDER])).value, false)
  const hold = await one<{ resolution_code: string; resolved_by: string }>(db, "select resolution_code, resolved_by::text from order_cancellation_holds where order_id=$1", [LOCAL_ORDER])
  assert.deepEqual([hold.resolution_code, hold.resolved_by], ["LOCAL-RETURN-RECEIVED", actor], "evidencia: quien recibió los bultos")
  assert.equal(await audits(db, LOCAL_ORDER, "dispatch_cancellation_physically_resolved"), 1)
  assert.equal(await audits(db, LOCAL_ORDER, "dispatch_cancellation_stock_restored"), 1)
  assert.deepEqual(await stock(db), initial, "cancelado: vuelve a 10, nunca 12")
  // Escanear de nuevo en Despachos ya no hace falta: la resolución existente responde "ya resuelto".
  const rescan = await one<{ result: { alreadyResolved: boolean } }>(db, "select resolve_cancelled_order_preparation($1,$2,$3) result", [codes[0], actor, key()])
  assert.equal(rescan.result.alreadyResolved, true)
  assert.equal(await audits(db, LOCAL_ORDER, "dispatch_cancellation_physically_resolved"), 1, "sin segunda recepción")
  assert.equal((await one<{ count: number }>(db, "select count(*)::int count from local_delivery_return_receipts")).count, 2, "sin recibos artificiales")
  await db.query("update local_delivery_return_reservations set starts_at=now()-interval '5 days', expires_at=now()-interval '1 minute'")
  assert.equal((await one<{ result: { expired: number } }>(db, "select expire_local_delivery_return_reservations(100) result")).result.expired, 0, "cancelada no vence")
  assert.deepEqual(await stock(db), initial)
})

test("vencida y después cancelada: 10 → 8 → 8 → 10 (vence) → 10 (cancela), nunca 12", async () => {
  const db = await setup()
  const { codes } = await returning(db)
  const sold = await stock(db)
  const initial = { productA: sold.productA + 2, productB: sold.productB + 1, red: sold.red + 2 }
  assert.deepEqual([initial.red, sold.red], [10, 8], "10 → 8 con el pedido")
  await receive(db, codes[0])
  await receive(db, codes[1])
  assert.equal((await stock(db)).red, 8, "devuelto y reservado: 8")
  await db.query("update local_delivery_return_reservations set starts_at=now()-interval '5 days', expires_at=now()-interval '1 minute'")
  await db.query("select expire_local_delivery_return_reservations(100)")
  assert.deepEqual(await stock(db), initial, "vencida: 10")
  await db.query("update ordenes set estado='cancelado', cancelled_at=now(), payment_status='cancelado' where id=$1", [LOCAL_ORDER])
  assert.equal((await one<{ value: boolean }>(db, "select order_has_active_stock_hold($1) value", [LOCAL_ORDER])).value, false, "retención resuelta con la recepción")
  assert.deepEqual(await stock(db), initial, "cancelada: 10, nunca 12")
  assert.equal((await one<{ count: number }>(db, "select count(*)::int count from inventory_movements where source='local_delivery_return_release'")).count, 0,
    "el pedido dejó de consumir stock: la rama de liberación ya no aplica")
})

test("pedido cancelado mientras volvía: se recibe físicamente pero no se reserva", async () => {
  const db = await setup()
  const { codes } = await returning(db)
  await db.query("update ordenes set estado='cancelado', cancelled_at=now(), payment_status='cancelado' where id=$1", [LOCAL_ORDER])
  await receive(db, codes[0])
  const done = await receive(db, codes[1])
  assert.equal(done.complete, true)
  assert.equal(done.reservationExpiresAt, null)
  assert.equal((await one<{ count: number }>(db, "select count(*)::int count from local_delivery_return_reservations")).count, 0)
  // Retención de la cancelación: abierta mientras faltaban bultos, resuelta con la recepción completa.
  assert.equal((await one<{ value: boolean }>(db, "select order_has_active_stock_hold($1) value", [LOCAL_ORDER])).value, false)
  assert.equal(await audits(db, LOCAL_ORDER, "dispatch_cancellation_physically_resolved"), 1)
})

test("cancelado mientras volvía con un bulto faltante: la retención sigue pendiente (no se inventa evidencia)", async () => {
  const db = await setup()
  const { codes } = await returning(db)
  await receive(db, codes[0])
  await db.query("update ordenes set estado='cancelado', cancelled_at=now(), payment_status='cancelado' where id=$1", [LOCAL_ORDER])
  assert.equal((await one<{ value: boolean }>(db, "select order_has_active_stock_hold($1) value", [LOCAL_ORDER])).value, true)
  assert.equal(await audits(db, LOCAL_ORDER, "dispatch_cancellation_physically_resolved"), 0)
})

test("cola de Despachos: 200 devueltos no ocupan el cupo; un pedido nuevo y cada subestado operativo aparecen", async () => {
  const db = await setup()
  // 200 pedidos Envío BEYONIX viejos ya Devueltos a BEYONIX (ordenes.estado sigue en_camino).
  await db.exec(`
    insert into ordenes(id, shipping_provider, andreani_envio_id, andreani_creation_status, estado)
      select g, 'beyonix', null, null, 'en_camino' from generate_series(1, 200) g;
    insert into local_delivery_shipments(order_id, access_token, outcome_status, failed_attempts, first_attempt_failed_at,
        second_attempt_failed_at, returning_at, returned_at, returned_by)
      select g, 'returnedToken' || lpad(g::text, 12, '0'), 'returned', 2, now(), now(), now(), now(), '${actor}'
      from generate_series(1, 200) g;
  `)
  // Subestados operativos: nuevo (sin QR), pendiente, 1.er intento, incidencia y regresando; y uno entregado.
  await db.exec(`
    insert into ordenes(id, shipping_provider, andreani_envio_id, andreani_creation_status, estado) values
      (5001, 'beyonix', null, null, 'pagado'), (5002, 'beyonix', null, null, 'en_camino'), (5003, 'beyonix', null, null, 'en_camino'),
      (5004, 'beyonix', null, null, 'en_camino'), (5005, 'beyonix', null, null, 'en_camino'), (5006, 'beyonix', null, null, 'entregado');
    insert into local_delivery_shipments(order_id, access_token, outcome_status, failed_attempts, first_attempt_failed_at,
        second_attempt_failed_at, incident_reason, incident_at, returning_at, delivered_at) values
      (5002, 'queuePendingToken0000000001', 'pending', 0, null, null, null, null, null, null),
      (5003, 'queueFirstFailToken00000001', 'first_attempt_failed', 1, now(), null, null, null, null, null),
      (5004, 'queueIncidentToken000000001', 'incident', 0, null, null, 'no_access', now(), null, null),
      (5005, 'queueReturningToken00000001', 'returning', 2, now(), now(), null, null, now(), null),
      (5006, 'queueDeliveredToken00000001', 'delivered', 0, null, null, null, null, null, now());
  `)
  const queue = async (name: string, limit: number) =>
    (await db.query<{ id: string }>("select local_delivery_queue_order_ids($1,$2) id", [name, limit])).rows.map((row) => Number(row.id))
  const operational = await queue("operational", 200)
  for (const id of [5001, 5002, 5003, 5004, 5005]) assert.ok(operational.includes(id), `operativo ${id}`)
  assert.ok(operational.every((id) => id > 200 && id !== 5006), "ni devueltos ni entregados ocupan el cupo operativo")
  // Con el cupo mínimo, el primer operativo es el pedido más viejo NO devuelto (nunca uno devuelto).
  const [firstOperational] = await queue("operational", 1)
  assert.ok(firstOperational > 200, String(firstOperational))
  const returned = await queue("returned", 500)
  assert.equal(returned.length, 200)
  assert.ok(returned.every((id) => id <= 200), "sólo devueltos en su propia lista")
  // Devuelto con reserva activa primero (coordinación pendiente con el cliente).
  await db.exec(`insert into local_delivery_return_reservations(shipment_id, order_id, reservation_days, starts_at, expires_at, created_by)
    select id, order_id, 3, now(), now() + interval '3 days', '${actor}' from local_delivery_shipments where order_id = 150`)
  assert.equal((await queue("returned", 5))[0], 150)
  // Cancelado no entra en ninguna cola.
  await db.query("update ordenes set cancelled_at=now(), estado='cancelado' where id=5002")
  assert.equal((await queue("operational", 200)).includes(5002), false)
  assert.equal((await one<{ value: boolean }>(db, "select has_function_privilege('authenticated', 'public.local_delivery_queue_order_ids(text,integer)', 'execute') value")).value, false)
})

test("stock con descuento: la reserva vencida también devuelve unidades a su oferta", async () => {
  const db = await setup()
  const { codes } = await returning(db)
  // El ítem se vendió como stock con descuento (se asocia después del pickeo del fixture).
  await db.exec(`
    insert into inventory_return_movements(id,product_id,discounted_quantity,conditioned_name,conditioned_sku,conditioned_color_hex,conditioned_active,approved_at)
      values ('a0000000-0000-4000-8000-000000000001',2,3,'Ñandú lámpara (caja abierta)','SKU-B-CA','#112233',true,now());
    update orden_items set conditioned_stock_id='a0000000-0000-4000-8000-000000000001' where id=2;
  `)
  const available = async () => (await one<{ value: number }>(db, "select available_quantity::int value from conditioned_inventory_offers where id='a0000000-0000-4000-8000-000000000001'")).value
  assert.equal(await available(), 2, "1 vendida al pedido")
  await receive(db, codes[0])
  await receive(db, codes[1])
  assert.equal(await available(), 2, "reservada para el pedido")
  await db.query("update local_delivery_return_reservations set starts_at=now()-interval '5 days', expires_at=now()-interval '1 minute'")
  await db.query("select expire_local_delivery_return_reservations(100)")
  assert.equal(await available(), 3, "vuelve a la oferta con descuento")
  const catalog = await one<{ value: number }>(db, "select available_quantity::int value from conditioned_catalog_variants where id='a0000000-0000-4000-8000-000000000001'")
  assert.equal(catalog.value, 3)
})

test("Andreani aislado: ningún QR, resultado ni recepción local sobre un pedido Andreani", async () => {
  const db = await setup()
  await assert.rejects(ensure(db, ANDREANI_ORDER), /DISPATCH_LOCAL_DELIVERY_ONLY/)
  await db.query("update ordenes set estado='en_camino' where id=$1", [ANDREANI_ORDER])
  await db.query("update ordenes set estado='entregado' where id=$1", [ANDREANI_ORDER])
  assert.equal((await one<{ count: number }>(db, "select count(*)::int count from local_delivery_shipments")).count, 0)
  // Pedido local sin QR (etiquetas de antes de esta versión): Admin lo sigue entregando igual.
  await prepare(db, LOCAL_SINGLE, 1)
  await db.query("update ordenes set estado='en_camino' where id=$1", [LOCAL_SINGLE])
  await db.query("update ordenes set estado='entregado', delivered_at=now() where id=$1", [LOCAL_SINGLE])
})

test("permisos: anon y authenticated no leen tablas ni ejecutan RPC del circuito", async () => {
  const db = await setup()
  const grants = await db.query<{ grantee: string; privilege_type: string; table_name: string }>(
    "select grantee, privilege_type, table_name from information_schema.role_table_grants where table_name like 'local_delivery_%' and grantee in ('anon','authenticated','PUBLIC')")
  assert.deepEqual(grants.rows, [])
  for (const fn of [
    "ensure_local_delivery_shipment(bigint,uuid,text)", "record_local_delivery_courier_outcome(text,text,integer,text,text)",
    "mark_local_delivery_delivered_by_courier(text)", "receive_local_delivery_return_parcel(text,uuid,integer)",
    "expire_local_delivery_return_reservations(integer)", "consume_local_delivery_return_reservation(bigint,uuid)",
    "resolve_local_delivery_incident(bigint,uuid,text)",
  ]) {
    for (const role of ["anon", "authenticated"]) {
      const allowed = await one<{ value: boolean }>(db, "select has_function_privilege($1, $2, 'execute') value", [role, `public.${fn}`])
      assert.equal(allowed.value, false, `${role} no ejecuta ${fn}`)
    }
  }
})
