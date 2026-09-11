import assert from "node:assert/strict"
import test from "node:test"

import { runMercadoPagoRefundReconciliationBatch } from "./reconciliation-batch.ts"

function fakeAdmin(rows: Array<{ id: string; order_id: number; payment_id: string; mp_refund_id: string | null }>) {
  const reconcileCalls: Array<Record<string, unknown>> = []
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "claim_mercadopago_refunds_for_reconciliation") {
        return { data: rows, error: null }
      }
      if (name === "reconcile_mercadopago_order_refund") {
        reconcileCalls.push(args)
        return { data: {}, error: null }
      }
      throw new Error(`rpc inesperada en el mock: ${name}`)
    },
  }
  return { admin, reconcileCalls }
}

test("un lote vacío no reconcilia nada", async () => {
  const { admin } = fakeAdmin([])
  const result = await runMercadoPagoRefundReconciliationBatch(admin as never)
  assert.deepEqual(result, { checked: 0, confirmed: 0, stillPending: 0, errors: 0 })
})

test("confirma contra Mercado Pago sólo por GET -- nunca dispara un POST de refund", async () => {
  const { admin, reconcileCalls } = fakeAdmin([
    { id: "r1", order_id: 1, payment_id: "9001", mp_refund_id: null },
  ])
  let getRefundStatusCalled = false
  const result = await runMercadoPagoRefundReconciliationBatch(admin as never, {
    getRefundStatus: async () => {
      getRefundStatusCalled = true
      return { kind: "found", refund: { id: 555, payment_id: 9001, amount: 70000 } }
    },
  })
  assert.equal(getRefundStatusCalled, true)
  assert.deepEqual(result, { checked: 1, confirmed: 1, stillPending: 0, errors: 0 })
  assert.equal(reconcileCalls[0].p_outcome, "confirmed")
})

test("sigue ambiguo tras reconsultar: queda pendiente, nunca se marca failed sin evidencia autoritativa", async () => {
  const { admin, reconcileCalls } = fakeAdmin([
    { id: "r1", order_id: 1, payment_id: "9001", mp_refund_id: null },
  ])
  const result = await runMercadoPagoRefundReconciliationBatch(admin as never, {
    getRefundStatus: async () => ({ kind: "unknown", reason: "timeout" }),
  })
  assert.deepEqual(result, { checked: 1, confirmed: 0, stillPending: 1, errors: 0 })
  assert.equal(reconcileCalls[0].p_outcome, "needs_reconciliation")
})

test("Mercado Pago confirma que nunca recibió el refund: queda otra vez intentable (requested), no 'failed'", async () => {
  const { admin, reconcileCalls } = fakeAdmin([
    { id: "r1", order_id: 1, payment_id: "9001", mp_refund_id: null },
  ])
  const result = await runMercadoPagoRefundReconciliationBatch(admin as never, {
    getRefundStatus: async () => ({ kind: "not_found" }),
  })
  assert.deepEqual(result, { checked: 1, confirmed: 0, stillPending: 1, errors: 0 })
  assert.equal(reconcileCalls[0].p_outcome, "requested")
})

test("procesa varios registros del lote de forma independiente -- un error en uno no interrumpe el resto", async () => {
  const { admin } = fakeAdmin([
    { id: "r1", order_id: 1, payment_id: "9001", mp_refund_id: null },
    { id: "r2", order_id: 2, payment_id: "9002", mp_refund_id: null },
  ])
  const result = await runMercadoPagoRefundReconciliationBatch(admin as never, {
    getRefundStatus: async (paymentId) => {
      if (paymentId === "9001") throw new Error("network down")
      return { kind: "found", refund: { id: 1, payment_id: 9002, amount: 1000 } }
    },
  })
  assert.equal(result.checked, 2)
  assert.equal(result.errors, 1)
  assert.equal(result.confirmed, 1)
})

test("errores de reconciliación se sanitizan en el log (nunca el token de acceso)", async () => {
  const { admin } = fakeAdmin([{ id: "r1", order_id: 1, payment_id: "9001", mp_refund_id: null }])
  const originalError = console.error
  const logs: unknown[] = []
  console.error = (...args: unknown[]) => logs.push(args)
  try {
    await runMercadoPagoRefundReconciliationBatch(admin as never, {
      getRefundStatus: async () => {
        throw new Error("fallo de red")
      },
    })
  } finally {
    console.error = originalError
  }
  const logged = JSON.stringify(logs)
  assert.doesNotMatch(logged, /Bearer |MERCADOPAGO_ACCESS_TOKEN=/)
})
