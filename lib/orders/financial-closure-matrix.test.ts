import assert from "node:assert/strict"
import test from "node:test"

import { buildCancellationNotification, buildOrderWorkNotifications } from "../admin/admin-notification-rules.ts"
import { getCancellationProgress } from "../admin/order-operational-progress.ts"
import { getAdminPendingOrderActions } from "./admin-pending-actions.ts"
import { getCancellationNextAction } from "./cancellation-next-action.ts"
import { getCancellationPanelViewModel } from "./cancellation-panel-view.ts"
import { getCreditNoteState } from "./credit-note-state.ts"
import { getOrderCancellationRefundState } from "./order-cancellation-refund-state.ts"

// Cierre del circuito Pago → Factura C → NC → reintegro → cierre.
// Las vistas (Cancelación, progreso, Facturación, pendientes, campana,
// Cliente) cuentan la misma historia para la misma orden.

type Note = { status: string; destination: string; settlement_status: string; total_amount: number; external_amount?: number | null }
type Refund = { status: string; created_at: string }
type Order = Record<string, unknown> & {
  id: number; total: number; payment_method_id: string; order_credit_notes: Note[]; mercadopago_order_refunds: Refund[]
}

// Snapshots de la base real (15/10/2026), sólo columnas del circuito.
const BX1002: Order = {
  id: 2, total: 1000, estado: "cancelado", financial_status: "refunded", payment_method_id: "mercadopago",
  payment_status: "refunded", paid_at: "2026-10-13T22:30:30Z", payment_confirmed_amount: 1000,
  refund_pending_at: "2026-10-13T22:33:59Z", refunded_at: "2026-10-13T22:42:31Z", cancelled_at: "2026-10-13T22:33:59Z",
  invoice_status: "authorized", invoice_cae: "86417596112941", invoice_number: 8, invoice_point: 1,
  invoice_queued_at: "2026-10-13T22:30:31Z", invoice_created_at: "2026-10-13T15:00:00Z",
  credit_note_required: true, credit_note_status: null,
  order_credit_notes: [], mercadopago_order_refunds: [{ status: "confirmed", created_at: "2026-10-13T22:42:30Z" }],
  order_audit_events: [{ id: 9, action: "mp_external_refund_detected", created_at: "2026-10-13T22:42:32Z", metadata: {}, audit_resolution: null }],
}
const BX1004: Order = {
  ...BX1002, id: 4, paid_at: "2026-10-14T03:23:38Z", refund_pending_at: "2026-10-14T03:28:37Z", refunded_at: "2026-10-14T03:29:54Z",
  cancelled_at: "2026-10-14T03:28:37Z", invoice_cae: "86417601175734", invoice_number: 9,
  credit_note_required: false, credit_note_status: "authorized", credit_note_amount: 1000,
  order_credit_notes: [{ status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 1000, external_amount: 1000 }],
  mercadopago_order_refunds: [{ status: "confirmed", created_at: "2026-10-14T03:29:53Z" }],
  order_audit_events: [{ id: 25, action: "mp_external_refund_detected", created_at: "2026-10-14T03:29:56Z", metadata: {}, audit_resolution: null }],
}
const BX1005: Order = {
  id: 5, total: 1000, estado: "pagado", financial_status: "payment_confirmed", payment_method_id: "mercadopago",
  payment_status: "approved", paid_at: "2026-10-14T23:05:23Z", payment_confirmed_amount: 1000,
  invoice_status: "authorized", invoice_cae: "86417747630716", invoice_number: 10, invoice_point: 1,
  invoice_queued_at: "2026-10-14T23:05:25Z", credit_note_required: false,
  order_credit_notes: [], mercadopago_order_refunds: [], order_audit_events: [],
}

const kinds = (order: Order) => getAdminPendingOrderActions(order as never).map((action) => action.kind)

test("BX-1002: 'Reintegro realizado · Nota de crédito pendiente', una sola acción fiscal, nunca otro reintegro", () => {
  const nc = getCreditNoteState(BX1002 as never)
  assert.equal(nc.state, "legacy_required")
  assert.equal(nc.emitAction, "legacy", "única acción: la NC heredada (sólo fiscal)")
  assert.equal(getCancellationNextAction(BX1002 as never).state, "completed", "el dinero ya volvió: ningún reintegro más")
  const panel = getCancellationPanelViewModel(BX1002 as never)
  assert.equal(panel.isFinished, true)
  assert.equal(panel.creditNotePending, true)
  assert.equal(panel.primaryAction, null, "no ofrece reintegrar ni registrar dinero")
  assert.deepEqual(getCancellationProgress(BX1002 as never), [{ label: "Nota de crédito", complete: false }, { label: "Reintegro", complete: true }])
  const actions = kinds(BX1002)
  assert.ok(actions.includes("legacy_credit_note"))
  assert.ok(!actions.some((kind) => ["refund", "refund_manual", "refund_retry"].includes(kind)), "sin acciones de dinero")
  assert.equal(getOrderCancellationRefundState(BX1002 as never), "refunded", "el cliente ve el reintegro realizado")
  const bell = buildOrderWorkNotifications(BX1002 as never).map((item) => item.eventKey)
  assert.ok(bell.includes("invoice:legacy_credit_note:2"), "la campana avisa la NC faltante")
})

test("BX-1004: NC autorizada + refund MP confirmado → todo emitido; sólo resta la liquidación heredada", () => {
  const nc = getCreditNoteState(BX1004 as never)
  assert.equal(nc.state, "settlement_pending", "la liquidación quedó 'pendiente' antes de 20261015120000")
  assert.equal(nc.emitAction, null, "nunca 'Emitir NC' con una NC autorizada")
  assert.equal(getCancellationNextAction(BX1004 as never).state, "completed")
  const panel = getCancellationPanelViewModel(BX1004 as never)
  assert.equal(panel.creditNotePending, false)
  assert.equal(panel.steps.find((step) => step.key === "credit_note")?.status ?? "done", "done")
  assert.ok(!kinds(BX1004).includes("legacy_credit_note"))
  // Tras settle_credit_notes_after_mercadopago_refund(4) queda liquidada.
  const settled = { ...BX1004, order_credit_notes: [{ ...BX1004.order_credit_notes[0], settlement_status: "completado" }] }
  assert.equal(getCreditNoteState(settled as never).state, "settled")
})

test("BX-1005: pagado y facturado, sin cancelación: no hay NC ni reintegro que ofrecer", () => {
  assert.equal(getCreditNoteState(BX1005 as never).state, "not_required")
  assert.equal(getCancellationNextAction(BX1005 as never).state, "none")
  assert.deepEqual(getCancellationProgress(BX1005 as never), [])
  assert.ok(!kinds(BX1005).some((kind) => ["legacy_credit_note", "refund", "payment_incident"].includes(kind)))
})

test("incidentes: sólo los abiertos cuentan; resolver o falso positivo los baja de la campana", () => {
  assert.ok(kinds(BX1004).includes("payment_incident"))
  assert.ok(buildOrderWorkNotifications(BX1004 as never).some((item) => item.eventKey === "payment:payment_incident:4"))
  const resolved = { ...BX1004, order_audit_events: [{ ...(BX1004.order_audit_events as Array<object>)[0], audit_resolution: { resolution: "false_positive", note: "Reintegro propio" } }] }
  assert.ok(!kinds(resolved).includes("payment_incident"))
  assert.ok(!buildOrderWorkNotifications(resolved as never).some((item) => item.eventKey.startsWith("payment:")))
  assert.equal(buildCancellationNotification(resolved as never), null, "pedido cerrado: ninguna alerta de cancelación")
})

// Matriz: medio de pago × momento de la cancelación × estado de NC/refund.
const methods = ["mercadopago", "transferencia", "customer_credit"] as const
const base = (method: string, overrides: Partial<Order> = {}): Order => ({
  id: 70, total: 100000, estado: "cancelado", financial_status: "refund_pending", payment_method_id: method,
  payment_status: "approved", paid_at: "2026-10-15T10:00:00Z", refund_pending_at: "2026-10-15T11:00:00Z",
  payment_confirmed_amount: method === "customer_credit" ? 0 : 70000, credit_balance_used: 30000,
  invoice_queued_at: "2026-10-15T10:00:01Z", invoice_status: "pending", invoice_cae: null,
  credit_note_required: false, order_credit_notes: [], mercadopago_order_refunds: [], order_audit_events: [],
  ...overrides,
})
const invoiced = { invoice_status: "authorized", invoice_cae: "CAE", invoice_number: 11, invoice_point: 1 }
const authorizedNote = (overrides: Partial<Note> = {}): Note => ({ status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 100000, external_amount: 70000, ...overrides })

test("matriz: ninguna vista contradice a otra (NC emitida vs 'Emitir NC', completado vs pendiente)", () => {
  const scenarios: Array<[string, Order]> = []
  for (const method of methods) {
    scenarios.push([`${method} · cancelación pre-factura`, base(method)])
    scenarios.push([`${method} · post-factura sin NC`, base(method, { ...invoiced, credit_note_required: true })])
    scenarios.push([`${method} · NC en ARCA`, base(method, { ...invoiced, credit_note_required: true, order_credit_notes: [{ ...authorizedNote(), status: "processing" }] })])
    scenarios.push([`${method} · NC con error ARCA`, base(method, { ...invoiced, credit_note_required: true, order_credit_notes: [{ ...authorizedNote(), status: "error" }] })])
    scenarios.push([`${method} · NC parcial`, base(method, { ...invoiced, order_credit_notes: [authorizedNote({ total_amount: 50000, external_amount: 35000 })] })])
    scenarios.push([`${method} · NC total`, base(method, { ...invoiced, order_credit_notes: [authorizedNote()] })])
    scenarios.push([`${method} · reintegrado`, base(method, { ...invoiced, financial_status: "refunded", refunded_at: "2026-10-15T12:00:00Z",
      order_credit_notes: [authorizedNote({ settlement_status: "completado" })] })])
  }
  for (const [name, order] of scenarios) {
    const nc = getCreditNoteState(order as never)
    const next = getCancellationNextAction(order as never)
    const panel = getCancellationPanelViewModel(order as never)
    const progress = getCancellationProgress(order as never)
    const actions = kinds(order)
    assert.ok(!(nc.authorized && nc.emitAction), `${name}: NC emitida y 'Emitir NC' a la vez`)
    if (nc.authorized) assert.notEqual(next.state, "emit_credit_note", `${name}: pide emitir otra NC`)
    const ncStep = progress.find((step) => step.label === "Nota de crédito")
    const panelStep = panel.steps.find((step) => step.key === "credit_note")
    if (ncStep && panelStep) assert.equal(ncStep.complete, panelStep.status === "done", `${name}: progreso y Cancelación difieren`)
    if (panel.isFinished && !panel.creditNotePending) assert.ok(!actions.some((kind) => kind.startsWith("refund")), `${name}: finalizado con acción de reintegro`)
    if (order.payment_method_id === "transferencia") assert.notEqual(next.state, "execute_mp_refund", `${name}: transferencia nunca por MP`)
    if (order.invoice_status !== "authorized") assert.ok(["blocked", "none"].includes(next.state), `${name}: sin factura no se devuelve dinero`)
  }
})

test("matriz MP: NC total → refund real; refund en curso → nada que ofrecer; MP no lo tiene → reintentar", () => {
  const total = base("mercadopago", { ...invoiced, order_credit_notes: [authorizedNote()] })
  assert.equal(getCancellationNextAction(total as never).state, "execute_mp_refund")
  for (const [status, expected] of [["processing", "none"], ["needs_reconciliation", "reconcile_mp_refund"], ["requested", "execute_mp_refund"], ["failed", "execute_mp_refund"]] as const) {
    assert.equal(getCancellationNextAction({ ...total, mercadopago_order_refunds: [{ status, created_at: "2026-10-15T12:00:00Z" }] } as never).state, expected, status)
  }
  const transfer = base("transferencia", { ...invoiced, order_credit_notes: [authorizedNote()] })
  assert.equal(getCancellationNextAction(transfer as never).state, "register_external_refund", "transferencia: comprobante manual")
})
