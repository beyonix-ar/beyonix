import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { classifyMercadoPagoRefundOrigin } from "./refund-origin.ts"

// Caso real (pedidos #2 y #4, 13-14/10/2026): BEYONIX confirmó el refund y
// 1-2 s después llegó el webhook "refunded" -- quedaba auditado como externo.
test("un refund propio ya confirmado no se audita como externo", () => {
  const confirmed = [{ mp_refund_id: "3442447402", amount: "1000.00" }]
  assert.equal(classifyMercadoPagoRefundOrigin({ refunds: [{ id: 3442447402, amount: 1000 }], transaction_amount_refunded: 1000 }, confirmed), "beyonix")
  assert.equal(classifyMercadoPagoRefundOrigin({ transaction_amount_refunded: 1000 }, confirmed), "beyonix", "sin detalle se compara el monto")
})

test("los refunds realmente externos se siguen detectando", () => {
  assert.equal(classifyMercadoPagoRefundOrigin({ refunds: [{ id: 1, amount: 1000 }], transaction_amount_refunded: 1000 }, []), "external", "sin intento propio")
  assert.equal(
    classifyMercadoPagoRefundOrigin(
      { refunds: [{ id: "3442447402", amount: 600 }, { id: "999", amount: 400 }], transaction_amount_refunded: 1000 },
      [{ mp_refund_id: "3442447402", amount: 600 }],
    ),
    "external",
    "un refund adicional hecho a mano en MP",
  )
  assert.equal(classifyMercadoPagoRefundOrigin({ transaction_amount_refunded: 1000 }, [{ mp_refund_id: null, amount: 600 }]), "external", "MP devolvió más de lo confirmado")
  assert.equal(classifyMercadoPagoRefundOrigin({ refunds: [{ id: "777" }] }, [{ mp_refund_id: "3442447402", amount: 1000 }]), "external", "id distinto al registrado")
})

test("el webhook consulta los refunds propios confirmados del mismo pago antes de auditar externo", () => {
  const webhook = readFileSync(new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url), "utf8")
  const block = webhook.slice(webhook.indexOf("const { data: pendingAttempt }"), webhook.indexOf('action: "mp_external_refund_detected"'))
  assert.match(block, /\.eq\("payment_id", String\(payment\.id\)\)\s*\n\s*\.eq\("status", "confirmed"\)/)
  assert.match(block, /else if \(refundOrigin === "beyonix"\)/)
  assert.match(block, /confirmedAttemptsError\s*\n?\s*\? "external"/, "si no se puede verificar, se audita igual")
})
