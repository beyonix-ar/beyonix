import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// FASE 2: integración del webhook con mercadopago_order_refunds. Mismo
// patrón que el resto de los tests de este archivo (order-payment.test.ts):
// contrato sobre el código fuente real del webhook, porque levantar la ruta
// completa requiere mockear firma HMAC + Supabase + fetch a MP (no se hace
// en ningún test existente de este archivo tampoco). Nunca se ejecuta el
// webhook contra red real ni credenciales.

const webhook = readFileSync(
  new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
  "utf8",
)

test("el chequeo de reversa post-confirmación (firma/replay/ownership) sigue exactamente igual -- FASE 2 sólo agrega lógica DENTRO de ese bloque ya validado", () => {
  assert.match(
    webhook,
    /POST_CONFIRMATION_REVERSAL_STATUSES\.has\(payment\.status\)\s*&&\s*\n\s*orderRow\.payment_id === String\(payment\.id\)\s*&&\s*\n\s*orderRow\.payment_status !== payment\.status/,
  )
  assert.match(webhook, /\.neq\("payment_status", payment\.status\)/)
})

test("charged_back siempre es un incidente auditado -- nunca se reconcilia como refund cooperativo ni toca financial_status", () => {
  const block = webhook.slice(
    webhook.indexOf('if (payment.status === "charged_back")'),
    webhook.indexOf("} else {", webhook.indexOf('if (payment.status === "charged_back")')),
  )
  assert.match(block, /action: "mp_chargeback_detected"/)
  assert.doesNotMatch(block, /financial_status:\s*"refunded"/)
  assert.doesNotMatch(block, /reconcileMercadoPagoOrderRefund/)
})

test("refunded con un intento propio pendiente se reconcilia (GET vía reconcileMercadoPagoOrderRefund), nunca dispara un nuevo POST", () => {
  assert.match(webhook, /from\("mercadopago_order_refunds"\)/)
  assert.match(webhook, /\.in\("status", \["processing", "needs_reconciliation"\]\)/)
  assert.match(webhook, /if \(pendingAttempt\) \{\s*\n\s*await reconcileMercadoPagoOrderRefund\(supabase, \{ orderId \}\)/)
  assert.doesNotMatch(webhook, /createMercadoPagoRefund/, "el webhook nunca debe importar/llamar al POST de refund")
})

test("refunded SIN ningún intento propio se audita como refund externo, sin inventar una operación", () => {
  assert.match(webhook, /action: "mp_external_refund_detected"/)
  assert.match(webhook, /reason: "refund_not_initiated_by_beyonix"/)
})

test("la reconciliación/auditoría de FASE 2 vive DENTRO del guard idempotente existente (reversalUpdated) -- eventos duplicados/fuera de orden no la re-disparan", () => {
  const guardIndex = webhook.indexOf("} else if (reversalUpdated) {")
  const chargebackIndex = webhook.indexOf('action: "mp_chargeback_detected"')
  const externalRefundIndex = webhook.indexOf('action: "mp_external_refund_detected"')
  const nextTopLevelBlock = webhook.indexOf("return NextResponse.json({ ok: true, duplicated: true })", guardIndex)
  assert.ok(guardIndex > 0 && chargebackIndex > guardIndex && chargebackIndex < nextTopLevelBlock)
  assert.ok(externalRefundIndex > guardIndex && externalRefundIndex < nextTopLevelBlock)
})

test("no se debilitó ninguna protección existente: firma HMAC, replay, reconsulta real y validación de monto/ARS siguen intactas", () => {
  assert.match(webhook, /validateMercadoPagoWebhookSignature/)
  assert.match(webhook, /claimMercadoPagoWebhookDelivery/)
  assert.match(webhook, /getMercadoPagoPayment\(paymentId\)/)
  assert.match(webhook, /processApprovedMercadoPagoOrderPayment/)
  assert.match(webhook, /isMercadoPagoOrderCancelled/)
  assert.match(webhook, /MERCADOPAGO_APPROVED_AFTER_CANCELLATION_STATUS/)
})
