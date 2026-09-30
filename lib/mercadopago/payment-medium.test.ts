import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { getMercadoPagoPaymentMedium } from "./payment-medium.ts"

// D. Medio REAL del pago (tipo, marca y cuotas) frente a la modalidad que
// eligió el cliente: sólo trazabilidad, nunca rechaza un pago aprobado.

test("D. crédito pagado con tarjeta de crédito: se registra tipo, marca y cuotas reales", () => {
  for (const installments of [1, 3, 4, 6]) {
    assert.deepEqual(
      getMercadoPagoPaymentMedium({ payment_type_id: "credit_card", payment_method_id: "visa", installments }, "mercadopago_financed"),
      {
        payment_type_id: "credit_card",
        payment_method_id: "visa",
        installments,
        checkout_modality: "mercadopago_financed",
        matches_checkout_modality: true,
      },
      `1 pago o ${installments} cuotas con crédito es válido`,
    )
  }
})

test("D. crédito pagado con Dinero en cuenta: se registra y queda marcado (no coincide), sin rechazar", () => {
  assert.deepEqual(
    getMercadoPagoPaymentMedium({ payment_type_id: "account_money", payment_method_id: "account_money", installments: 1 }, "mercadopago_financed"),
    {
      payment_type_id: "account_money",
      payment_method_id: "account_money",
      installments: 1,
      checkout_modality: "mercadopago_financed",
      matches_checkout_modality: false,
    },
  )
})

test("al contado: débito, dinero en cuenta y prepaga coinciden; crédito no", () => {
  for (const [type, method] of [["debit_card", "debvisa"], ["account_money", "account_money"], ["prepaid_card", "prepaid"]]) {
    assert.equal(
      getMercadoPagoPaymentMedium({ payment_type_id: type, payment_method_id: method, installments: 1 }, "mercadopago_cash").matches_checkout_modality,
      true,
      type,
    )
  }
  assert.equal(
    getMercadoPagoPaymentMedium({ payment_type_id: "credit_card", payment_method_id: "master", installments: 1 }, "mercadopago_cash").matches_checkout_modality,
    false,
  )
})

test("órdenes previas al modelo o datos incompletos: se registra lo que haya, sin inventar la comparación", () => {
  assert.deepEqual(
    getMercadoPagoPaymentMedium({ payment_type_id: "credit_card", payment_method_id: "visa", installments: 3 }, undefined),
    { payment_type_id: "credit_card", payment_method_id: "visa", installments: 3, checkout_modality: null, matches_checkout_modality: null },
  )
  assert.deepEqual(
    getMercadoPagoPaymentMedium({ payment_type_id: "  ", payment_method_id: null, installments: 0 }, "mercadopago_cash"),
    { payment_type_id: null, payment_method_id: null, installments: null, checkout_modality: "mercadopago_cash", matches_checkout_modality: null },
  )
})

// Contrato sobre el webhook real (mismo patrón que order-payment.test.ts y
// webhook-refund-integration.test.ts: firma HMAC + Supabase + MP no se
// levantan en tests).
const webhook = readFileSync(new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n")

test("D. el webhook persiste el medio real: payment_type_id (tipo) y, en el snapshot, marca, cuotas, modalidad y coincidencia", () => {
  assert.match(webhook, /pricing_snapshot"\)/, "lee la modalidad elegida de la orden")
  assert.match(webhook, /getMercadoPagoPaymentMedium\(\s*payment,\s*orderRow\.pricing_snapshot\?\.mercadoPagoModality,\s*\)/)
  assert.match(webhook, /payment_method_id: "mercadopago",/, "el medio a nivel BEYONIX no cambia")
  assert.match(webhook, /payment_type_id: paymentMedium\.payment_type_id,/)
  const snapshot = webhook.slice(webhook.indexOf("mercadopago_payment_snapshot: {"), webhook.indexOf("},", webhook.indexOf("mercadopago_payment_snapshot: {")))
  for (const field of ["installments: paymentMedium.installments", "payment_type_id: paymentMedium.payment_type_id", "payment_method_id: paymentMedium.payment_method_id", "checkout_modality: paymentMedium.checkout_modality", "matches_checkout_modality: paymentMedium.matches_checkout_modality", "fee_details", "transaction_details"]) {
    assert.ok(snapshot.includes(field), field)
  }
})

test("un medio fuera de modalidad sólo se audita DESPUÉS de confirmar: no rechaza, no cambia estado ni monto", () => {
  const confirmed = webhook.indexOf('action: "payment_confirmed"')
  const outside = webhook.indexOf('action: "payment_medium_outside_modality"')
  assert.ok(confirmed > 0 && outside > confirmed, "el evento de revisión va después de la confirmación")
  const block = webhook.slice(webhook.indexOf("if (paymentMedium.matches_checkout_modality === false)"), outside + 600)
  assert.doesNotMatch(block, /\.update\(|NextResponse\.json\(|throw /, "sólo agrega un evento de auditoría")
  assert.match(block, /previousStatus: "payment_confirmed",\s*newStatus: "payment_confirmed"/)
  // La validación de monto exacto + ARS sigue siendo la única que decide.
  assert.ok(webhook.indexOf("processApprovedMercadoPagoOrderPayment(") < confirmed)
  assert.doesNotMatch(webhook, /matches_checkout_modality[^\n]*(amount_mismatch|reject)/)
})
