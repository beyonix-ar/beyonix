import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { processApprovedMercadoPagoOrderPayment } from "./order-payment.ts"

test("un pago aprobado con monto incorrecto no confirma la orden", async () => {
  let confirmations = 0
  const result = await processApprovedMercadoPagoOrderPayment(
    {
      estado: "pendiente",
      financial_status: "pending_payment",
      total: 25_000,
      external_amount_due: 20_000.5,
    },
    {
      status: "approved",
      currency_id: "ARS",
      transaction_amount: 20_000.49,
    },
    async () => {
      confirmations += 1
      return true
    },
  )

  assert.equal(result.kind, "amount_mismatch")
  assert.equal(confirmations, 0)
})

test("un pago aprobado confirma el importe real correcto en centavos", async () => {
  let persistedAmount: number | null = null
  const result = await processApprovedMercadoPagoOrderPayment(
    {
      estado: "pendiente",
      financial_status: "pending_payment",
      total: 25_000,
      external_amount_due: 20_000.5,
    },
    {
      status: "approved",
      currency_id: "ARS",
      transaction_amount: 20_000.5,
    },
    async (confirmedAmount) => {
      persistedAmount = confirmedAmount
      return true
    },
  )

  assert.deepEqual(result, {
    kind: "confirmed",
    confirmedAmount: 20_000.5,
  })
  assert.equal(persistedAmount, 20_000.5)
})

test("repetir un webhook confirmado no repite la confirmación", async () => {
  const order = {
    estado: "pendiente",
    financial_status: "pending_payment",
    total: 10_000,
    external_amount_due: 10_000,
  }
  const payment = {
    status: "approved",
    currency_id: "ARS",
    transaction_amount: 10_000,
  }
  let confirmations = 0
  const confirm = async () => {
    confirmations += 1
    order.estado = "pagado"
    order.financial_status = "payment_confirmed"
    return true
  }

  const first = await processApprovedMercadoPagoOrderPayment(
    order,
    payment,
    confirm,
  )
  const repeated = await processApprovedMercadoPagoOrderPayment(
    order,
    payment,
    confirm,
  )

  assert.equal(first.kind, "confirmed")
  assert.equal(repeated.kind, "duplicate")
  assert.equal(confirmations, 1)
})

test("una carrera perdida se trata como webhook duplicado", async () => {
  let sideEffects = 0
  const result = await processApprovedMercadoPagoOrderPayment(
    {
      estado: "pendiente",
      financial_status: "pending_payment",
      total: 10_000,
      external_amount_due: 10_000,
    },
    {
      status: "approved",
      currency_id: "ARS",
      transaction_amount: 10_000,
    },
    async () => false,
  )

  if (result.kind === "confirmed") sideEffects += 1

  assert.equal(result.kind, "duplicate")
  assert.equal(sideEffects, 0)
})

test("el webhook duplicado no crea stock ni factura como efecto lateral", () => {
  const webhook = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )

  assert.doesNotMatch(
    webhook,
    /(?:reserve|decrement|update).*stock|create.*(?:invoice|factura)/i,
  )
  assert.match(
    webhook,
    /if \(paymentResult\.kind === "duplicate"\)[\s\S]*duplicated: true/,
  )
})

test("el webhook valida el pago contra el importe ya financiado, no recalcula porcentajes de cuotas", () => {
  const webhook = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )

  // El recargo por financiación ya quedó horneado en total/external_amount_due
  // al crear la orden (antes de pagar): el webhook sigue comparando contra
  // esos mismos campos, sin importarle nunca cuotas/porcentajes/config.
  assert.doesNotMatch(webhook, /products\/installments/)
  assert.doesNotMatch(webhook, /installments_percent/)
  assert.match(webhook, /processApprovedMercadoPagoOrderPayment/)

  // Persiste el costo REAL informado por Mercado Pago (distinto del %
  // configurado) para poder mostrar a futuro costos/neto reales en Admin.
  assert.match(webhook, /mercadopago_payment_snapshot/)
  assert.match(webhook, /fee_details/)
  assert.match(webhook, /transaction_details/)
})
