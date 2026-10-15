import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { getAdminPendingOrderActions } from "./admin-pending-actions.ts"
import { AUTO_CANCELLATION_STALE_MS, getAutomaticCancellationStatus } from "./automatic-cancellation-state.ts"

// "Procesando automáticamente" sólo con actividad real del worker; trabado o
// derivado a Admin → "Requiere acción" y vuelve el flujo manual.

const control = { enabled: true, cutoffAt: "2026-10-14T03:24:06.029661Z" }
const cancelledAt = "2026-10-15T16:01:15.531402Z"
// BX-1005 tal como está en la base real (15/10/2026 16:13).
const bx1005 = {
  estado: "cancelado", financial_status: "refund_pending", invoice_status: "authorized",
  invoice_queued_at: "2026-10-14T23:05:25.134678Z", invoice_requested_at: "2026-10-14T23:10:02.685117Z",
  cancelled_at: cancelledAt, cancellation_requested_at: cancelledAt, refund_pending_at: cancelledAt,
  auto_cancellation_next_attempt_at: "-infinity", auto_cancellation_claimed_until: null, auto_cancellation_error: null,
}
const at = (iso: string) => Date.parse(iso)

test("BX-1005: 'procesando' sólo durante el margen del worker; después 'Requiere acción'", () => {
  assert.deepEqual(getAutomaticCancellationStatus(bx1005, control, at("2026-10-15T16:02:00Z")), { state: "processing" })
  assert.deepEqual(getAutomaticCancellationStatus(bx1005, control, at(cancelledAt) + AUTO_CANCELLATION_STALE_MS + 1_000),
    { state: "requires_action", reason: "stalled", error: null })
  assert.deepEqual(getAutomaticCancellationStatus(bx1005, control, at("2026-10-15T16:13:37Z")),
    { state: "requires_action", reason: "stalled", error: null }, "la captura real: 12 min sin worker")
})

test("actividad real: lease vigente o reintento programado → procesando; reintento vencido sin worker → requiere acción", () => {
  const now = at("2026-10-15T17:00:00Z")
  assert.deepEqual(getAutomaticCancellationStatus({ ...bx1005, auto_cancellation_claimed_until: "2026-10-15T17:03:00Z" }, control, now),
    { state: "processing" }, "un worker lo tiene tomado")
  assert.deepEqual(getAutomaticCancellationStatus({ ...bx1005, auto_cancellation_next_attempt_at: "2026-10-15T17:30:00Z",
    auto_cancellation_error: "ARCA_CREDIT_NOTE_RETRY" }, control, now), { state: "processing" }, "backoff vigente")
  assert.deepEqual(getAutomaticCancellationStatus({ ...bx1005, auto_cancellation_next_attempt_at: "2026-10-15T16:30:00Z",
    auto_cancellation_error: "MP_RECONCILIATION" }, control, now),
  { state: "requires_action", reason: "stalled", error: "MP_RECONCILIATION" }, "el reintento venció hace 30 min")
  // Lease vencido de un worker muerto: cuenta como trabado si ya pasó el margen.
  assert.equal(getAutomaticCancellationStatus({ ...bx1005, auto_cancellation_claimed_until: "2026-10-15T16:05:00Z" }, control, now)?.state,
    "requires_action")
})

test("derivado a Admin (release con 'infinity') → requiere acción con el motivo", () => {
  assert.deepEqual(getAutomaticCancellationStatus({ ...bx1005, auto_cancellation_next_attempt_at: "infinity",
    auto_cancellation_error: "BANK_TRANSFER_REFUND_REQUIRED" }, control, at("2026-10-15T16:02:00Z")),
  { state: "requires_action", reason: "manual", error: "BANK_TRANSFER_REFUND_REQUIRED" })
})

test("fuera del automático: control apagado, backlog previo al corte, sin cancelación o ya reintegrado", () => {
  const now = at("2026-10-15T16:02:00Z")
  assert.equal(getAutomaticCancellationStatus(bx1005, { ...control, enabled: false }, now), null)
  assert.equal(getAutomaticCancellationStatus(bx1005, null, now), null)
  assert.equal(getAutomaticCancellationStatus({ ...bx1005, financial_status: "refunded" }, control, now), null)
  assert.equal(getAutomaticCancellationStatus({ ...bx1005, estado: "pagado", financial_status: "payment_confirmed" }, control, now), null)
  const backlog = { ...bx1005, invoice_queued_at: "2026-10-13T10:00:00Z", cancelled_at: "2026-10-13T11:00:00Z",
    cancellation_requested_at: "2026-10-13T11:00:00Z", refund_pending_at: "2026-10-13T11:00:00Z" }
  assert.equal(getAutomaticCancellationStatus(backlog, control, now), null, "venta y cancelación anteriores a la activación")
  // Compra de antes del corte cancelada después: entra (misma regla que el claim).
  assert.deepEqual(getAutomaticCancellationStatus({ ...backlog, cancelled_at: cancelledAt }, control, now), { state: "processing" })
  // Cancelación antes de la factura: espera el CAE (la cola de facturación tiene su propio estado).
  assert.deepEqual(getAutomaticCancellationStatus({ ...bx1005, invoice_status: "pending" }, control, at("2026-10-16T10:00:00Z")),
    { state: "processing" })
})

test("pendientes: procesando → sin tarea humana; trabado → vuelve la acción de Cancelación", () => {
  const order = {
    id: 5, total: 1000, estado: "cancelado", financial_status: "refund_pending", payment_method_id: "mercadopago",
    payment_status: "approved", paid_at: "2026-10-14T23:05:23Z", payment_confirmed_amount: 1000, refund_pending_at: cancelledAt,
    invoice_status: "authorized", invoice_cae: "86417747630716", invoice_number: 10, invoice_point: 1,
    invoice_queued_at: "2026-10-14T23:05:25Z", credit_note_required: true, order_credit_notes: [], mercadopago_order_refunds: [],
  }
  const facts = { financial: null, dispatch: null }
  const processing = getAdminPendingOrderActions({ ...order, admin_pending_facts: { ...facts, cancellationAutomatic: true } } as never)
  assert.ok(!processing.some((action) => action.kind.startsWith("refund")), "el worker lo está resolviendo")
  const stalled = getAdminPendingOrderActions({ ...order, admin_pending_facts: { ...facts, cancellationAutomatic: false,
    cancellationAutomaticIssue: { reason: "stalled", error: null } } } as never)
  assert.ok(stalled.some((action) => action.kind === "refund" && action.urgent), "Requiere acción: tarea urgente en Cancelación")
})

test("UI: el aviso 'Requiere acción' se muestra en Cancelación y Facturación; los hechos usan el helper", () => {
  const admin = readFileSync("app/admin/sections/pedidos/admin-pedidos.tsx", "utf8")
  assert.equal(admin.match(/<AutomaticCancellationIssueNotice pedido=\{pedido\} \/>/g)?.length, 3, "wizard, panel clásico y Facturación")
  assert.match(admin, /Requiere acción: la cancelación automática no avanzó a tiempo/)
  const facts = readFileSync("lib/orders/admin-pending-facts-server.ts", "utf8")
  assert.match(facts, /cancellationAutomatic: automaticCancellation\?\.state === "processing"/)
  const route = readFileSync("app/api/admin/pedidos/route.ts", "utf8")
  for (const column of ["auto_cancellation_claimed_until", "auto_cancellation_error", "invoice_requested_at"]) {
    assert.ok(route.includes(`"${column}"`), `la vista de notificaciones trae ${column}`)
  }
})
