import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { dispatchBatchName, dispatchPage, dispatchQueueStatus, filterDispatchOrders, selectVisibleOrders, type QueueOrder } from "./dispatch-queue"

const order = (id: number, created_at = "2026-10-15T23:00:00-03:00"): QueueOrder => ({
  id, created_at, estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized",
  shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null,
  andreani_handed_over_batch_id: null, cliente_nombre: "Lucas", andreani_envio_id: null, andreani_tracking: null,
  andreani_creation_status: null, package: null, membership: null,
})

test("un pedido viejo sigue pendiente hasta quedar preparado y persiste al reconstruir la cola", () => {
  const old = order(6)
  assert.equal(dispatchQueueStatus(old), "pending")
  assert.equal(filterDispatchOrders([old], "", "").length, 1)
  const prepared: QueueOrder = { ...old, package: { id: 1, order_id: 6, status: "prepared", attempt_number: 1, prepared_at: "2026-10-16T15:00:00Z", prepared_by: null } }
  assert.equal(dispatchQueueStatus(prepared), "confirmed")
  assert.equal(dispatchQueueStatus({ ...prepared }), "confirmed")
  assert.equal(dispatchQueueStatus({ ...prepared, membership: { id: 10 } }), "in_batch")
})

test("búsqueda BX o número y fecha del pedido en Buenos Aires", () => {
  const orders = [order(6), order(7, "2026-10-16T12:00:00Z")]
  assert.deepEqual(filterDispatchOrders(orders, "BX-1006", "").map((item) => item.id), [6])
  assert.deepEqual(filterDispatchOrders(orders, "1006", "").map((item) => item.id), [6])
  assert.deepEqual(filterDispatchOrders(orders, "", "2026-10-15").map((item) => item.id), [6])
  assert.deepEqual(filterDispatchOrders(orders, "", "2026-10-16").map((item) => item.id), [7])
})

test("paginación de 20 se reacomoda y la selección total afecta sólo la página visible", () => {
  const orders = Array.from({ length: 45 }, (_, id) => order(id + 1))
  assert.equal(dispatchPage(orders, 1).items.length, 20)
  assert.equal(dispatchPage(orders, 2).items[0].id, 21)
  assert.equal(dispatchPage(orders, 3).items.length, 5)
  assert.equal(dispatchPage(orders.slice(0, 20), 3).currentPage, 1)
  const selected = selectVisibleOrders(new Set<number>([25]), dispatchPage(orders, 1).items.map((item) => item.id), true)
  assert.equal(selected.size, 21)
  assert.ok(selected.has(25))
  assert.deepEqual([...selectVisibleOrders(selected, [1, 2], false)].filter((id) => id <= 2), [])
})

test("número visible nuevo e históricos DSP", () => {
  assert.equal(dispatchBatchName({ id: 9, display_number: 1 }), "Bulto - 0001")
  assert.equal(dispatchBatchName({ id: 10, display_number: 2 }), "Bulto - 0002")
  assert.equal(dispatchBatchName({ id: 7, display_number: null }), "Bulto - 0007")
  const migration = readFileSync("supabase/migrations/20261016170000_dispatch_batch_display_numbers.sql", "utf8")
  assert.match(migration, /create sequence public\.dispatch_batch_display_number_seq as bigint start with 1/i)
  assert.match(migration, /create unique index dispatch_batches_display_number_unique/i)
  assert.match(migration, /set default nextval/i)
  const schema = readFileSync("supabase/migrations/20261005100000_dispatch_operations.sql", "utf8")
  assert.match(schema, /dispatch_batch_items_active_order_unique/)
})
