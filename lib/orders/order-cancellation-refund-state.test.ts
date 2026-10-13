import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  getClientOrderStatusBadge,
  getCustomerRefundSummary,
  getOrderProgressSteps,
  getPaymentProgressLabel,
} from "../account/account-utils.ts"
import type { SupabasePedido } from "../supabase/types.ts"
import { ADMIN_EXECUTIVE_STATUS } from "./admin-order-status-presentation.ts"
import { getOrderCancellationRefundState, ORDER_CANCELLATION_REFUND_LABELS } from "./order-cancellation-refund-state.ts"

const SHIPPING_STEPS = ["Esperando confirmación del pago", "Preparando envío", "En camino", "Entregado"]

// Forma real del pedido BX-1002 (pagado por MP, cancelado y reintegrado).
const refundedOrder: SupabasePedido = {
  id: 2,
  usuario_id: "cliente-1",
  created_at: "2026-10-13T22:29:56.511Z",
  estado: "cancelado",
  total: 1000,
  external_amount_due: 1000,
  payment_method_id: "mercadopago",
  payment_status: "refunded",
  financial_status: "refunded",
  paid_at: "2026-10-13T22:30:30.000Z",
  cancelled_at: "2026-10-13T22:33:59.945Z",
  cancellation_requested_at: "2026-10-13T22:33:59.945Z",
  refund_pending_at: "2026-10-13T22:33:59.945Z",
  refund_amount: 1000,
  refund_method: "mercadopago",
  refunded_at: "2026-10-13T22:42:31.371Z",
}
const refundInProgressOrder: SupabasePedido = {
  ...refundedOrder,
  payment_status: "approved",
  financial_status: "refund_pending",
  refund_amount: null,
  refund_method: null,
  refunded_at: null,
}
const cancelledWithoutPayment: SupabasePedido = {
  id: 1,
  usuario_id: "cliente-1",
  created_at: "2026-10-13T22:00:00.000Z",
  estado: "cancelado",
  total: 1000,
  payment_method_id: "mercadopago",
  payment_status: "checkout_superseded",
  financial_status: "cancelled",
  paid_at: null,
  cancelled_at: "2026-10-13T22:10:00.000Z",
}

const labels = (order: SupabasePedido) => getOrderProgressSteps(order).map((step) => step.label)

test("estado compartido: sin pago → cancelado; reintegro pendiente → en proceso; reintegrado → realizado", () => {
  assert.equal(getOrderCancellationRefundState(cancelledWithoutPayment), "cancelled")
  assert.equal(getOrderCancellationRefundState(refundInProgressOrder), "refund_in_progress")
  assert.equal(getOrderCancellationRefundState(refundedOrder), "refunded")
  // Pago real llegado después de cancelar: hay dinero que devolver.
  assert.equal(getOrderCancellationRefundState({ ...cancelledWithoutPayment, payment_status: "approved_after_cancellation" }), "refund_in_progress")
  // Cancelado con cobro sin financial_status de reintegro (dato legacy): en proceso, nunca "sin pago".
  assert.equal(getOrderCancellationRefundState({ estado: "cancelado", financial_status: null, paid_at: "2026-10-13T22:30:30Z" }), "refund_in_progress")
  // Reintegro por reclamo después de la entrega: no es un pedido cancelado.
  assert.equal(getOrderCancellationRefundState({ estado: "entregado", financial_status: "refunded", paid_at: "2026-10-01T00:00:00Z" }), null)
})

test("cliente A: cancelado sin pago → Pedido cancelado, timeline final sin pasos de envío", () => {
  assert.equal(getClientOrderStatusBadge(cancelledWithoutPayment).label, "Pedido cancelado")
  assert.equal(getPaymentProgressLabel(cancelledWithoutPayment), "Pedido cancelado")
  assert.deepEqual(labels(cancelledWithoutPayment), ["Pedido registrado", "Pedido cancelado"])
  assert.equal(getOrderProgressSteps(cancelledWithoutPayment).at(-1)?.tone, "done", "estado final, no un paso pendiente")
  assert.equal(getCustomerRefundSummary(cancelledWithoutPayment), null, "sin reintegro inventado")
})

test("cliente B: reintegro en proceso → Pedido cancelado + Reintegro en proceso", () => {
  assert.equal(getClientOrderStatusBadge(refundInProgressOrder).label, "Pedido cancelado")
  assert.equal(getPaymentProgressLabel(refundInProgressOrder), "Reintegro en proceso")
  assert.deepEqual(labels(refundInProgressOrder), ["Pedido registrado", "Pago confirmado", "Pedido cancelado", "Reintegro en proceso"])
  for (const step of SHIPPING_STEPS) assert.ok(!labels(refundInProgressOrder).includes(step), step)
  assert.deepEqual(getCustomerRefundSummary(refundInProgressOrder), {
    state: "refund_in_progress", statusLabel: "En proceso", amount: 1000, methodLabel: null,
    requestedAt: "2026-10-13T22:33:59.945Z", completedAt: null,
  })
})

test("cliente C: reintegro completado → Reintegro realizado con importe, medio y fechas reales", () => {
  assert.equal(getClientOrderStatusBadge(refundedOrder).label, "Pedido cancelado")
  assert.equal(getPaymentProgressLabel(refundedOrder), "Reintegro realizado")
  assert.notEqual(getPaymentProgressLabel(refundedOrder), "Esperando confirmación del pago")
  assert.deepEqual(labels(refundedOrder), ["Pedido registrado", "Pago confirmado", "Pedido cancelado", "Reintegro realizado"])
  assert.ok(getOrderProgressSteps(refundedOrder).every((step) => step.tone === "done"))
  for (const step of SHIPPING_STEPS) assert.ok(!labels(refundedOrder).includes(step), step)
  assert.deepEqual(getCustomerRefundSummary(refundedOrder), {
    state: "refunded", statusLabel: "Realizado", amount: 1000, methodLabel: "Mercado Pago",
    requestedAt: "2026-10-13T22:33:59.945Z", completedAt: "2026-10-13T22:42:31.371Z",
  })
  // Medios registrados por los otros caminos de reintegro.
  assert.equal(getCustomerRefundSummary({ ...refundedOrder, refund_method: "Saldo BEYONIX" })?.methodLabel, "Saldo BEYONIX")
  assert.equal(getCustomerRefundSummary({ ...refundedOrder, refund_method: "Reintegro manual" })?.methodLabel, "Transferencia bancaria")
})

test("rechazado por Admin (nunca pagado): timeline final en rojo, sin reintegro", () => {
  const rejected: SupabasePedido = {
    ...cancelledWithoutPayment,
    order_audit_events: [{ action: "order_rejected_by_admin", actor_type: "admin", previous_status: null, new_status: "cancelled", metadata: {}, created_at: "2026-10-13T22:10:00Z" }],
  } as SupabasePedido
  const steps = getOrderProgressSteps(rejected)
  assert.deepEqual(steps.map((step) => [step.label, step.tone]), [["Pedido registrado", "done"], ["Pedido rechazado", "danger"]])
})

test("Admin usa la misma fuente de verdad: Cancelado / Cancelado · Reintegro en proceso / Cancelado · Reintegrado", () => {
  assert.equal(ADMIN_EXECUTIVE_STATUS.cancelled_refunded.label, "Cancelado · Reintegrado")
  assert.equal(ADMIN_EXECUTIVE_STATUS.cancelled_refund_pending.label, "Cancelado · Reintegro en proceso")
  assert.equal(ORDER_CANCELLATION_REFUND_LABELS.cancelled.admin, "Cancelado")
  const admin = readFileSync("app/admin/sections/pedidos/admin-pedidos.tsx", "utf8")
  assert.match(admin, /const cancellationRefundState = getOrderCancellationRefundState\(pedido\)/)
  // Un cancelado reintegrado también aparece en los filtros de reintegro.
  assert.match(admin, /pedido\.financial_status === statusFilter/)
})

test("regresión: pedidos normales, pendientes y entregados siguen igual", () => {
  const pending: SupabasePedido = {
    id: 3, usuario_id: "cliente-1", created_at: "2026-10-13T22:00:00Z", estado: "pendiente", total: 1000,
    payment_method_id: "mercadopago", payment_status: "preference_created", financial_status: "pending_payment",
  }
  assert.equal(getOrderCancellationRefundState(pending), null)
  assert.equal(getPaymentProgressLabel(pending), "Esperando confirmación del pago")
  assert.deepEqual(labels(pending), ["Pedido registrado", "Esperando confirmación del pago", "Preparando envío", "En camino", "Entregado"])

  const paid: SupabasePedido = { ...pending, estado: "pagado", payment_status: "approved", financial_status: "payment_confirmed", paid_at: "2026-10-13T22:05:00Z" }
  assert.deepEqual(labels(paid), ["Pedido registrado", "Pago aprobado", "Preparando envío", "En camino", "Entregado"])
  assert.equal(getOrderProgressSteps(paid)[2].tone, "current")

  const delivered: SupabasePedido = { ...paid, estado: "entregado", delivered_at: "2026-10-15T12:00:00Z" }
  assert.ok(getOrderProgressSteps(delivered).every((step) => step.tone === "done"))
  assert.equal(getClientOrderStatusBadge(delivered).label, "Entregado")

  const shipped: SupabasePedido = { ...paid, estado: "en_camino", tracking_number: "AND123" }
  assert.equal(getOrderProgressSteps(shipped)[3].tone, "current")
})

test("detalle del cliente cancelado: timeline final, bloque de reintegro, NC real o pendiente real y relectura al volver", () => {
  const client = readFileSync("app/cuenta/cuenta-client.tsx", "utf8")
  const cancelledBranch = client.slice(client.indexOf("if (isCancelled) {"), client.indexOf("customer-order-detail-page order-detail-solid-surface"))
  assert.match(cancelledBranch, /<OrderProgressTimeline order=\{order\} \/>/)
  assert.match(cancelledBranch, /const refundSummary = getCustomerRefundSummary\(order\)/)
  assert.match(cancelledBranch, /data-refund-summary/)
  for (const field of ["Estado", "Importe", "Medio", "Solicitado", "Realizado"]) assert.match(cancelledBranch, new RegExp(`>${field}</dt>`))
  // NC: el comprobante existente (sólo autorizado) o el pendiente real; nunca inventada.
  assert.match(cancelledBranch, /\{creditNoteSection\}/)
  assert.match(cancelledBranch, /\["pending", "processing"\]\.includes\(order\.credit_note_status/)
  assert.match(cancelledBranch, /Nota de crédito pendiente de emisión/)
  assert.match(client, /order\.credit_note_status === "authorized" &&/)
  // Una pestaña abierta antes del pago/cancelación se actualiza al volver.
  assert.match(client, /document\.addEventListener\("visibilitychange", reloadWhenVisible\)/)
})
