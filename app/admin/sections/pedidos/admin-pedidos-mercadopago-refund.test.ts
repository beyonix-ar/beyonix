import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// FASE 2: alertas admin visibles para eventos financieros de Mercado Pago
// que antes sólo quedaban en console.error. Contrato de texto -- este
// archivo (~7000 líneas, con hooks/estado de UI) no se importa/ejecuta
// directamente en los tests de este proyecto (ver el resto de tests de esta
// carpeta y de components/claims, todos de contrato).

const source = readFileSync(
  new URL("./admin-pedidos.tsx", import.meta.url),
  "utf8",
)

test("needs_reconciliation muestra una señal clara y distinta de un reintegro pendiente normal", () => {
  assert.match(
    source,
    /latestMpRefund\?\.status === "needs_reconciliation"[\s\S]{0,120}statusLabel: "Reintegro MP: revisar", tone: "danger"/,
  )
})

test("un reintegro externo (payment_status='refunded' sin que BEYONIX lo haya iniciado) se distingue de 'Confirmado'", () => {
  assert.match(
    source,
    /pedido\.payment_status === "refunded"\)\s*\{\s*\n\s*return \{ method, statusLabel: "Reintegro externo: revisar", tone: "danger" \}/,
  )
})

test("charged_back sigue mostrando el badge de contracargo existente (no se degradó)", () => {
  assert.match(
    source,
    /pedido\.payment_status === "charged_back"\)\s*\{\s*\n\s*return \{ method, statusLabel: "Contracargo", tone: "danger" \}/,
  )
})

test("las nuevas señales corren ANTES de la rama genérica 'Confirmado' -- nunca quedan enmascaradas", () => {
  const reconciliationIndex = source.indexOf('statusLabel: "Reintegro MP: revisar"')
  const externalRefundIndex = source.indexOf('statusLabel: "Reintegro externo: revisar"')
  const confirmedIndex = source.indexOf('isOrderPaymentConfirmed(pedido)) {\n    return { method, statusLabel: "Confirmado"')
  assert.ok(reconciliationIndex > 0 && externalRefundIndex > 0 && confirmedIndex > 0)
  assert.ok(reconciliationIndex < confirmedIndex)
  assert.ok(externalRefundIndex < confirmedIndex)
})
