import assert from "node:assert/strict"
import test from "node:test"

import { getOrderPaymentTotalDisplay } from "./account-utils.ts"

// BX-1001 (auditoría): intento de Mercado Pago abandonado -- estado='pendiente',
// payment_status='preference_created', financial_status='pending_payment',
// sin paid_at/payment_confirmed_amount/payment_id. Antes de este fix, tanto
// el historial como el detalle de compra mostraban "TOTAL PAGADO $72.914"
// para esta orden real, sin que existiera ningún pago aprobado.

test("MP pendiente (preference_created, nunca se pagó) -- NO dice 'Total pagado'", () => {
  const display = getOrderPaymentTotalDisplay({
    payment_status: "preference_created",
    financial_status: "pending_payment",
    paid_at: null,
    payment_confirmed_amount: null,
  })

  assert.equal(display.label, "Total del pedido")
  assert.notEqual(display.label, "Total pagado")
})

test("MP rejected (pago rechazado por Mercado Pago) -- NO dice 'Total pagado'", () => {
  const display = getOrderPaymentTotalDisplay({
    payment_status: "rejected",
    financial_status: "pending_payment",
    paid_at: null,
    payment_confirmed_amount: null,
  })

  assert.equal(display.label, "Total del pedido")
})

test("MP cancelled (cancelado desde Checkout Pro) -- NO dice 'Total pagado'", () => {
  const display = getOrderPaymentTotalDisplay({
    payment_status: "cancelled",
    financial_status: "pending_payment",
    paid_at: null,
    payment_confirmed_amount: null,
  })

  assert.equal(display.label, "Total del pedido")
})

test("MP approved (pago realmente confirmado) -- SÍ dice 'Total pagado'", () => {
  const display = getOrderPaymentTotalDisplay({
    payment_status: "approved",
    financial_status: "payment_confirmed",
    paid_at: "2026-09-22T23:10:00.000Z",
    payment_confirmed_amount: 72914,
  })

  assert.equal(display.label, "Total pagado")
})

test("reintegro pendiente/reintegrado: el pago SÍ existió -- sigue diciendo 'Total pagado' (no es lo mismo que nunca haberse pagado)", () => {
  for (const financialStatus of ["refund_pending", "refunded"]) {
    const display = getOrderPaymentTotalDisplay({
      payment_status: "approved",
      financial_status: financialStatus,
      paid_at: "2026-09-20T10:00:00.000Z",
      payment_confirmed_amount: 50000,
    })

    assert.equal(display.label, "Total pagado")
  }
})

test("nunca decide sólo por `estado` -- una orden abandonada/reclamable (fix de reintentos MP) sigue en estado='pendiente' sin que eso implique pago", () => {
  // Mismo shape que getMercadoPagoCheckoutAttemptDecision trata como
  // "claim_preference" (reclamable): estado sigue 'pendiente'.
  const display = getOrderPaymentTotalDisplay({
    payment_status: "preference_created",
    financial_status: "pending_payment",
    paid_at: null,
    payment_confirmed_amount: null,
  })

  assert.equal(display.label, "Total del pedido")
})
