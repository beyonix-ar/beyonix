import assert from "node:assert/strict"
import test from "node:test"

import { isDashboardCommercialSale, isDashboardPaidSale } from "../business/dashboard-financials.ts"
import {
  describeTestOrderBlockers,
  hasUnsupportedRestock,
  isTestOrderConfirmationValid,
  isTestOrderReasonValid,
  normalizeTestOrderReason,
  parseTestOrderRestockPlan,
  pendingRestockUnits,
  testOrderConfirmationText,
} from "./test-order-classification.ts"

test("confirmación explícita: número público exacto, sin importar mayúsculas ni espacios", () => {
  assert.equal(testOrderConfirmationText(19), "BX-1019")
  assert.equal(isTestOrderConfirmationValid(19, " bx-1019 "), true)
  assert.equal(isTestOrderConfirmationValid(19, "BX-1020"), false)
  assert.equal(isTestOrderConfirmationValid(19, "1019"), false)
})

test("motivo: 10 a 500 caracteres, con texto en español", () => {
  assert.equal(normalizeTestOrderReason("  Compra de prueba del dueño, conservó el producto  "), "Compra de prueba del dueño, conservó el producto")
  assert.equal(normalizeTestOrderReason(42), "")
  assert.equal(isTestOrderReasonValid("Prueba ñandú"), true)
  assert.equal(isTestOrderReasonValid("corto"), false)
  assert.equal(isTestOrderReasonValid("x".repeat(501)), false)
})

test("bloqueos en lenguaje humano (incluye los del archivo)", () => {
  assert.deepEqual(describeTestOrderBlockers(["not_authorized_test_order", "buyer_not_internal", "open_claim", "desconocido"]), [
    "Este pedido no está autorizado como compra de prueba. Sólo se clasifican pruebas verificadas y autorizadas de antemano.",
    "Sólo se pueden clasificar compras hechas con una cuenta interna del equipo, nunca la de un cliente.",
    "Hay un reclamo abierto.",
    "desconocido",
  ])
})

test("plan de reingreso: valida la respuesta de la base y suma sólo lo pendiente", () => {
  const plan = parseTestOrderRestockPlan([
    { orderItemId: 26, productId: 22, variantId: 22, productName: "AURICULAR ÑANDÚ", variantName: "Negro", quantity: 1, consumed: 1, returned: 0, released: 0, compensated: 0, pending: 1, supported: true },
    { orderItemId: 27, productId: 30, variantId: null, productName: "Acondicionado", variantName: null, quantity: 2, consumed: 2, returned: 0, released: 0, compensated: 0, pending: 2, supported: false },
  ])
  assert.ok(plan)
  assert.equal(pendingRestockUnits(plan), 3)
  assert.equal(hasUnsupportedRestock(plan), true)
  assert.equal(hasUnsupportedRestock(plan.slice(0, 1)), false)
  assert.equal(parseTestOrderRestockPlan(null), null)
  assert.equal(parseTestOrderRestockPlan([{ orderItemId: 1, productId: 1, quantity: 1, consumed: 1, returned: 0, released: 0, compensated: 0, pending: -1 }]), null)
  assert.equal(parseTestOrderRestockPlan([{ orderItemId: "x" }]), null)
})

test("dashboard: una compra de prueba es cobro (fiscal) pero no venta comercial", () => {
  const paid = { estado: "entregado", payment_status: "approved", financial_status: "payment_confirmed", paid_at: "2026-11-06T01:14:56Z", payment_confirmed_amount: 20 }
  assert.equal(isDashboardPaidSale(paid), true)
  assert.equal(isDashboardCommercialSale(paid), true)
  const testOrder = { ...paid, test_order_at: "2026-11-24T20:00:00Z" }
  assert.equal(isDashboardPaidSale(testOrder), true, "sigue en los controles fiscales")
  assert.equal(isDashboardCommercialSale(testOrder), false, "fuera de ventas, ingresos y ticket")
  assert.equal(isDashboardCommercialSale({ estado: "cancelado", payment_status: "approved_after_cancellation" }), false)
})
