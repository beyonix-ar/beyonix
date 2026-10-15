import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { auditMercadoPagoRefundsForOrder } from "./refund-incidents.ts"

// Contrato del webhook (levantar la ruta completa exige firma HMAC + Supabase
// + MP reales) y ejecución real de la auditoría de refunds con un admin falso.

const webhook = readFileSync(
  new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n")
const branchStart = webhook.indexOf("if (isMercadoPagoOrderAlreadyConfirmed(orderRow)) {")
const confirmedBranch = webhook.slice(branchStart, webhook.indexOf("return NextResponse.json({ ok: true, duplicated: true })", branchStart))

test("la reversa post-confirmación sigue idempotente y sólo para el mismo pago", () => {
  assert.match(confirmedBranch, /const samePayment = orderRow\.payment_id === String\(payment\.id\)/)
  assert.match(confirmedBranch, /POST_CONFIRMATION_REVERSAL_STATUSES\.has\(payment\.status\)\s*&&\s*\n\s*orderRow\.payment_status !== payment\.status/)
  assert.match(confirmedBranch, /\.neq\("payment_status", payment\.status\)/)
})

test("los refunds se auditan aunque el pago siga 'approved' (reintegro parcial) y nunca con un POST", () => {
  assert.match(confirmedBranch, /else if \(samePayment && hasMercadoPagoRefundSignal\(payment\)\) \{/)
  assert.match(confirmedBranch, /auditMercadoPagoRefundsForOrder\(supabase, \{ orderId, payment \}\)/)
  assert.ok(confirmedBranch.indexOf("auditMercadoPagoRefundsForOrder") > confirmedBranch.indexOf('if (samePayment && payment.status === "charged_back")'),
    "la auditoría está fuera del bloque que sólo corre al cambiar payment.status")
  assert.doesNotMatch(webhook, /createMercadoPagoRefund|refundMercadoPagoOrderPayment/, "el webhook nunca hace POST de refund")
})

test("contracargo: incidente único por pago, nunca financial_status ni conciliación como refund propio", () => {
  assert.match(confirmedBranch, /if \(samePayment && payment\.status === "charged_back"\) \{[\s\S]*recordMercadoPagoChargebackIncident\(supabase, orderId, String\(payment\.id\)\)/)
  assert.doesNotMatch(confirmedBranch, /financial_status:\s*"refunded"/)
})

test("no se debilitó ninguna protección existente: firma HMAC, replay, reconsulta real y validación de monto/ARS", () => {
  assert.match(webhook, /validateMercadoPagoWebhookSignature/)
  assert.match(webhook, /claimMercadoPagoWebhookDelivery/)
  assert.match(webhook, /getMercadoPagoPayment\(paymentId\)/)
  assert.match(webhook, /processApprovedMercadoPagoOrderPayment/)
  assert.match(webhook, /isMercadoPagoOrderCancelled/)
  assert.match(webhook, /MERCADOPAGO_APPROVED_AFTER_CANCELLATION_STATUS/)
  // Un error de auditoría responde 500: MP reintenta (nunca se silencia).
  assert.match(webhook, /if \(replayClaim\) releaseMercadoPagoWebhookDelivery\(replayClaim\)/)
})

type Attempt = { status: string; mp_refund_id: string | null; amount: number }

function fakeAdmin(state: { attempts: Attempt[]; incidents: Map<string, unknown>; failLookup?: boolean; alerted?: number }) {
  const query = (table: string) => {
    const chain = {
      select: () => chain, eq: () => chain,
      like: async () => ({ data: state.alerted ? [{ metadata: { amount: state.alerted } }] : [], error: null }),
      then: (resolve: (value: unknown) => void) => resolve(state.failLookup
        ? { data: null, error: { message: "timeout" } }
        : { data: table === "mercadopago_order_refunds" ? state.attempts : [], error: null }),
    }
    return chain
  }
  return {
    from: query,
    rpc: async (name: string, args: { p_incident_key: string; p_metadata: unknown }) => {
      assert.equal(name, "record_mercadopago_payment_incident")
      if (state.incidents.has(args.p_incident_key)) return { data: false, error: null }
      state.incidents.set(args.p_incident_key, args.p_metadata)
      return { data: true, error: null }
    },
  } as never
}

const payment = { id: 183036116203, transaction_amount: 80000, refunds: [{ id: 555, amount: 70000 }, { id: 777, amount: 10000 }], transaction_amount_refunded: 80000 }

test("auditoría real: $70.000 propios + $10.000 externos → una sola alerta por $10.000, idempotente", async () => {
  const state = { attempts: [{ status: "confirmed", mp_refund_id: "555", amount: 70000 }], incidents: new Map<string, unknown>() }
  const first = await auditMercadoPagoRefundsForOrder(fakeAdmin(state), { orderId: 4, payment })
  assert.equal(first.recorded, 1)
  assert.deepEqual(state.incidents.get("mp_refund:777"), { paymentId: "183036116203", mpRefundId: "777", amount: 10000, partial: true, reason: "refund_not_registered_by_beyonix" })
  // Webhook repetido: la base ignora la misma clave.
  const again = await auditMercadoPagoRefundsForOrder(fakeAdmin(state), { orderId: 4, payment })
  assert.equal(again.recorded, 0)
  assert.equal(state.incidents.size, 1)
})

test("intento propio en curso: se concilia por GET antes de comparar (sin falso positivo)", async () => {
  const state = { attempts: [{ status: "processing", mp_refund_id: null, amount: 70000 }] as Attempt[], incidents: new Map<string, unknown>() }
  let reconciled = 0
  const result = await auditMercadoPagoRefundsForOrder(fakeAdmin(state), { orderId: 4, payment: { ...payment, refunds: [{ id: 555, amount: 70000 }], transaction_amount_refunded: 70000 } }, {
    reconcile: async () => { reconciled += 1; state.attempts = [{ status: "confirmed", mp_refund_id: "555", amount: 70000 }]; return { kind: "confirmed", mpRefundId: "555", amount: 70000 } },
  })
  assert.equal(reconciled, 1)
  assert.deepEqual(result.unknown, [])
})

test("si no se puede leer el estado local, falla (MP reintenta) en vez de alertar a ciegas", async () => {
  const state = { attempts: [], incidents: new Map<string, unknown>(), failLookup: true }
  await assert.rejects(auditMercadoPagoRefundsForOrder(fakeAdmin(state), { orderId: 4, payment }), /MERCADOPAGO_REFUND_ATTEMPTS_LOOKUP_FAILED/)
  assert.equal(state.incidents.size, 0)
})
