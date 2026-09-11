import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Contrato sobre el código fuente real del componente: este proyecto no
// levanta un DOM/React Testing Library para ningún componente admin (todos
// los tests existentes de app/admin/sections/pedidos y components/claims son
// de contrato de texto) -- se mantiene el mismo criterio acá. La AUTORIDAD
// real del doble click/concurrencia/validación es el backend, ya probado en
// profundidad en lib/mercadopago/order-refund-rpc.test.ts.

const component = readFileSync(
  new URL("./mercadopago-refund-action.tsx", import.meta.url),
  "utf8",
)

test("sólo se ofrece para pedidos pagados por Mercado Pago con financial_status='refund_pending' (botón no aparece en pedido inválido)", () => {
  assert.match(component, /if \(pedido\.payment_method_id !== "mercadopago"\) return null/)
  assert.match(component, /if \(pedido\.financial_status !== "refund_pending"\) return null/)
  assert.match(component, /if \(isOrderDispatchedForDisplay\(pedido\)\) return null/)
})

test("nunca permite elegir una cuenta bancaria ni modificar el monto del refund manualmente (ningún input editable de esos datos)", () => {
  assert.doesNotMatch(component, /<input(?![^>]*type="file")/)
  assert.doesNotMatch(component, /<select/)
  assert.doesNotMatch(component, /onChange.*amount|setAmount/i)
  // Sí debe EXPLICAR la restricción al admin (texto informativo, no un input).
  assert.match(component, /no se puede elegir una cuenta bancaria/i)
})

test("explica que el dinero vuelve al medio de pago original antes de confirmar", () => {
  assert.match(component, /medio de pago original/)
})

test("requiere confirmación explícita en dos pasos antes de disparar el POST", () => {
  const [, confirmSection] = component.split("{!confirming ? (")
  assert.ok(confirmSection)
  assert.match(confirmSection, /Confirmar reintegro/)
  assert.match(component, /const \[confirming, setConfirming\] = useState\(false\)/)
})

test("previene doble click: el botón de confirmar queda disabled mientras submitting", () => {
  assert.match(component, /const \[submitting, setSubmitting\] = useState\(false\)/)
  assert.match(component, /disabled=\{submitting\}[\s\S]{0,80}onClick=\{initiateRefund\}/)
  assert.match(component, /setSubmitting\(true\)/)
})

test("cubre los 5 estados: requested/processing en curso, needs_reconciliation con reconciliar, confirmed terminal, failed permite reintentar", () => {
  assert.match(component, /\["requested", "processing"\]\.includes\(latestAttempt\.status\)/)
  assert.match(component, /latestAttempt\?\.status === "needs_reconciliation"/)
  assert.match(component, /latestAttempt\?\.status === "confirmed"/)
  assert.match(component, /latestAttempt\?\.status === "failed"/)
})

test("needs_reconciliation ofrece reconciliar (GET), nunca reintenta el refund (POST) directamente", () => {
  const needsReconciliationBlock = component.slice(
    component.indexOf('latestAttempt?.status === "needs_reconciliation"'),
    component.indexOf("if (isOrderDispatchedForDisplay"),
  )
  assert.match(needsReconciliationBlock, /onClick=\{retryReconciliation\}/)
  assert.doesNotMatch(needsReconciliationBlock, /onClick=\{initiateRefund\}/)
})

test("las llamadas al backend nunca envían un monto -- el backend es la única autoridad sobre el importe", () => {
  const postCall = component.slice(
    component.indexOf("const initiateRefund"),
    component.indexOf("const retryReconciliation"),
  )
  assert.doesNotMatch(postCall, /body:\s*JSON\.stringify/)
  assert.match(postCall, /method: "POST"/)
})
