import assert from "node:assert/strict"
import test from "node:test"

import { getCuentaItemColor, getOrderPaymentTotalDisplay, isInvoiceAwaitingRetry, isInvoiceGenerating } from "./account-utils.ts"
import type { SupabasePedido } from "../supabase/types.ts"

test("Mis compras muestra disponibilidad aleatoria sin exponer el color técnico", () => {
  const item = {
    id: 1, orden_id: 1, producto_id: 1, cantidad: 1, precio: 100,
    producto_variantes: { nombre: "ALEATORIO" },
  } as NonNullable<SupabasePedido["orden_items"]>[number]
  assert.equal(getCuentaItemColor(item), "Aleatorio según disponibilidad")
})

function order(invoiceStatus: SupabasePedido["invoice_status"], paid = true): SupabasePedido {
  return {
    id: 1,
    usuario_id: "cliente-1",
    estado: paid ? "pagado" : "pendiente",
    total: 100,
    created_at: "2026-10-03T12:00:00.000Z",
    payment_status: paid ? "approved" : "preference_created",
    paid_at: paid ? "2026-10-03T12:05:00.000Z" : null,
    invoice_status: invoiceStatus,
  }
}

test("el aviso de factura en generación solo aparece para pagos confirmados pendientes o en proceso", () => {
  assert.equal(isInvoiceGenerating(order("pending")), true)
  assert.equal(isInvoiceGenerating(order("processing")), true)
  assert.equal(isInvoiceGenerating(order("pending", false)), false)
  assert.equal(isInvoiceGenerating(order("authorized")), false)
  assert.equal(isInvoiceGenerating(order("error")), false)
  assert.equal(isInvoiceGenerating(order(null)), false)
})

test("un pago confirmado con error fiscal muestra espera sin exponer detalles de ARCA", () => {
  assert.equal(isInvoiceAwaitingRetry(order("error")), true)
  assert.equal(isInvoiceAwaitingRetry(order("error", false)), false)
  assert.equal(isInvoiceAwaitingRetry(order("authorized")), false)
  assert.equal(isInvoiceAwaitingRetry({ ...order("error"), invoice_cae: "CAE" }), false)
})

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
