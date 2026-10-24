import assert from "node:assert/strict"
import test from "node:test"

import {
  getClientOrderStatusBadge,
  getCustomerShippingMilestone,
  getOrderProgressSteps,
} from "../account/account-utils.ts"
import type { SupabasePedido } from "../supabase/types.ts"
import { getAdminDispatchStatus, getAdminShippingStage } from "./admin-order-status-presentation.ts"
import { getDispatchProgress, getShippingStage, SHIPPING_STAGE_LABELS, type DispatchProgress } from "./shipping-stage.ts"

const handedOverAt = "2026-10-22T16:54:00Z"
const paid: SupabasePedido = {
  id: 1012, usuario_id: "cliente-1", created_at: "2026-10-22T10:00:00Z", estado: "pagado", total: 50000,
  payment_method_id: "mercadopago", payment_status: "approved", financial_status: "payment_confirmed", paid_at: "2026-10-22T10:05:00Z",
  shipping_provider: "andreani", andreani_tracking: "360000000001012",
}
const customer = (dispatch_progress: DispatchProgress | null, extra: Partial<SupabasePedido> = {}): SupabasePedido => ({ ...paid, dispatch_progress, ...extra })
const currentStep = (order: SupabasePedido) => getOrderProgressSteps(order).find((step) => step.tone === "current")?.label
const customerLabel = (order: SupabasePedido) => getCustomerShippingMilestone(order, true)?.label

test("dispatch_progress: pickeo, listo y QR final", () => {
  assert.equal(getDispatchProgress(null, null), null)
  assert.equal(getDispatchProgress(null, "preparing"), "preparing")
  assert.equal(getDispatchProgress(null, "prepared"), "ready")
  assert.equal(getDispatchProgress(handedOverAt, "prepared"), "dispatched")
  assert.equal(getDispatchProgress(handedOverAt, null), "dispatched")
})

test("A. pickeo iniciado → Preparando pedido", () => {
  const order = customer("preparing")
  assert.equal(customerLabel(order), "Preparando pedido")
  assert.equal(currentStep(order), "Preparando pedido")
  // Pagado sin pickeo todavía: también se está preparando.
  assert.equal(customerLabel(customer(null)), "Preparando pedido")
})

test("B. pickeo terminado, sin QR final → Listo para despachar", () => {
  const order = customer("ready")
  assert.equal(customerLabel(order), "Listo para despachar")
  assert.equal(currentStep(order), "Listo para despachar")
  assert.equal(getClientOrderStatusBadge(order).label, "Pago confirmado")
})

test("C/H. QR final (BX-1012/BX-1013) → Despachado; el cliente ya no ve Preparando envío", () => {
  const order = customer("dispatched")
  assert.equal(customerLabel(order), "Despachado")
  assert.equal(currentStep(order), "Despachado")
  assert.equal(getClientOrderStatusBadge(order).label, "Despachado")
  const steps = getOrderProgressSteps(order)
  assert.ok(!steps.some((step) => /Preparando envío/.test(step.label)))
  assert.deepEqual(steps.slice(2).map((step) => [step.label, step.tone]), [
    ["Preparando pedido", "done"], ["Listo para despachar", "done"], ["Despachado", "current"], ["En camino", "pending"], ["Entregado", "pending"],
  ])
  assert.equal(getCustomerShippingMilestone(order, true)?.detail, "Andreani recibió tu paquete.")
})

test("D. movimiento real de Andreani → En camino", () => {
  for (const order of [customer("dispatched", { estado: "en_camino" }), customer("dispatched", { andreani_estado: "En distribución" })]) {
    assert.equal(customerLabel(order), "En camino")
    assert.equal(currentStep(order), "En camino")
    assert.equal(getClientOrderStatusBadge(order).label, "En camino")
  }
  // Admisión de Andreani (estado `enviado`) sin movimiento: sigue Despachado.
  assert.equal(customerLabel(customer("dispatched", { estado: "enviado" })), "Despachado")
})

test("E. entrega final → Entregado", () => {
  const order = customer("dispatched", { estado: "entregado", delivered_at: "2026-10-24T12:00:00Z" })
  assert.equal(customerLabel(order), "Entregado")
  assert.equal(getClientOrderStatusBadge(order).label, "Entregado")
  assert.ok(getOrderProgressSteps(order).every((step) => step.tone === "done"))
})

test("F/G. el QR final nunca muestra Entregado ni En camino por sí solo", () => {
  const order = customer("dispatched")
  const visible = [
    customerLabel(order),
    getClientOrderStatusBadge(order).label,
    currentStep(order),
    getAdminDispatchStatus({ estado: "pagado", andreani_handed_over_at: handedOverAt }).label,
  ]
  for (const label of visible) assert.doesNotMatch(label ?? "", /Entregado|En camino/)
  assert.equal(getOrderProgressSteps(order).find((step) => step.label === "Entregado")?.tone, "pending")
  assert.equal(getOrderProgressSteps(order).find((step) => step.label === "En camino")?.tone, "pending")
})

test("I. Admin y cliente muestran la misma etapa para los mismos hechos", () => {
  const cases: Array<{ estado: string; handed: string | null; packageStatus: "preparing" | "prepared" | null; expected: string; delivered_at?: string }> = [
    { estado: "pagado", handed: null, packageStatus: "preparing", expected: SHIPPING_STAGE_LABELS.preparing },
    { estado: "pagado", handed: null, packageStatus: "prepared", expected: SHIPPING_STAGE_LABELS.ready },
    { estado: "pagado", handed: handedOverAt, packageStatus: "prepared", expected: SHIPPING_STAGE_LABELS.dispatched },
    { estado: "enviado", handed: handedOverAt, packageStatus: "prepared", expected: SHIPPING_STAGE_LABELS.dispatched },
    { estado: "en_camino", handed: handedOverAt, packageStatus: "prepared", expected: SHIPPING_STAGE_LABELS.in_transit },
    { estado: "entregado", handed: handedOverAt, packageStatus: "prepared", expected: SHIPPING_STAGE_LABELS.delivered, delivered_at: "2026-10-24T12:00:00Z" },
  ]
  for (const item of cases) {
    const adminOrder = {
      estado: item.estado, delivered_at: item.delivered_at ?? null, andreani_handed_over_at: item.handed,
      admin_pending_facts: { dispatch: { packageStatus: item.packageStatus } },
    }
    const customerOrder = customer(getDispatchProgress(item.handed, item.packageStatus), { estado: item.estado, delivered_at: item.delivered_at ?? null })
    assert.equal(getAdminDispatchStatus(adminOrder).label, item.expected, `admin ${item.estado}`)
    assert.equal(customerLabel(customerOrder), item.expected, `cliente ${item.estado}`)
    const adminStage = getAdminShippingStage(adminOrder, true)
    assert.equal(adminStage ? SHIPPING_STAGE_LABELS[adminStage] : null, item.expected, `timeline admin ${item.estado}`)
  }
})

test("sin pago confirmado no hay etapas de preparación", () => {
  assert.equal(getShippingStage({ estado: "pendiente" }, { paymentConfirmed: false, dispatchProgress: null }), null)
  assert.equal(getShippingStage({ estado: "pendiente" }, { paymentConfirmed: false, dispatchProgress: "ready" }), null)
})
