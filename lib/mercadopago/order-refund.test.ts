import assert from "node:assert/strict"
import test from "node:test"

import {
  reconcileMercadoPagoOrderRefund,
  refundMercadoPagoOrderPayment,
} from "./order-refund.ts"

const orderId = 1
const paymentId = "9001"

function fakeAdmin(options: {
  begin?: { data?: unknown; error?: { message: string } | null }
  pendingRow?: { id: string; payment_id: string; mp_refund_id: string | null } | null
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      if (name === "begin_mercadopago_order_refund") {
        return options.begin ?? { data: null, error: { message: "not configured" } }
      }
      if (name === "record_mercadopago_order_refund_result") return { data: {}, error: null }
      if (name === "reconcile_mercadopago_order_refund") return { data: {}, error: null }
      throw new Error(`rpc inesperada en el mock: ${name}`)
    },
    from: (table: string) => {
      if (table !== "mercadopago_order_refunds") throw new Error(`tabla inesperada en el mock: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            in: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: options.pendingRow ?? null, error: null }),
                }),
              }),
            }),
          }),
        }),
      }
    },
  }
  return { admin, rpcCalls }
}

function beginAttempt(overrides: Partial<{
  refund_id: string
  payment_id: string
  amount: number
  idempotency_key: string
  status: string
  should_call_mp: boolean
  mp_refund_id: string | null
}> = {}) {
  return {
    refund_id: "attempt-1",
    payment_id: paymentId,
    amount: 70000,
    idempotency_key: "mercadopago-order-refund:attempt-1",
    status: "processing",
    should_call_mp: true,
    mp_refund_id: null,
    ...overrides,
  }
}

function approvedPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001,
    status: "approved",
    external_reference: String(orderId),
    currency_id: "ARS",
    transaction_amount: 70000,
    transaction_amount_refunded: 0,
    ...overrides,
  }
}

test("refund normal contra Mercado Pago: confirma y registra el resultado", async () => {
  const { admin, rpcCalls } = fakeAdmin({ begin: { data: [beginAttempt()], error: null } })
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    {
      getPayment: async () => approvedPayment() as never,
      createRefund: async () => ({ kind: "confirmed", refund: { id: 555, payment_id: 9001, amount: 70000 } }),
    },
  )
  assert.deepEqual(result, { kind: "confirmed", mpRefundId: "555", amount: 70000 })
  const recordCall = rpcCalls.find((c) => c.name === "record_mercadopago_order_refund_result")
  assert.equal(recordCall?.args.p_outcome, "confirmed")
  assert.equal(recordCall?.args.p_mp_refund_id, "555")
})

test("pedido mixto customer_credit ($30k) + MP ($70k): el refund de MP es EXACTAMENTE $70.000, nunca $100.000", async () => {
  const { admin } = fakeAdmin({ begin: { data: [beginAttempt({ amount: 70000 })], error: null } })
  let refundedAmountValidatedAgainst: number | null = null
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    {
      getPayment: async () => {
        refundedAmountValidatedAgainst = 70000
        return approvedPayment({ transaction_amount: 70000 }) as never
      },
      createRefund: async () => ({ kind: "confirmed", refund: { id: 1, payment_id: 9001, amount: 70000 } }),
    },
  )
  assert.equal(refundedAmountValidatedAgainst, 70000)
  assert.equal(result.kind, "confirmed")
  if (result.kind === "confirmed") assert.equal(result.amount, 70000)
})

test("payment_id incorrecto (no coincide con el persistido para la orden): fail-closed, nunca llama a createRefund", async () => {
  const { admin } = fakeAdmin({ begin: { data: [beginAttempt()], error: null } })
  let createRefundCalled = false
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    {
      getPayment: async () => approvedPayment({ id: 9999 }) as never,
      createRefund: async () => {
        createRefundCalled = true
        return { kind: "confirmed", refund: { id: 1, payment_id: 9999, amount: 70000 } }
      },
    },
  )
  assert.deepEqual(result, { kind: "validation_failed", reason: "PAYMENT_ID_MISMATCH" })
  assert.equal(createRefundCalled, false)
})

test("external_reference incorrecto: fail-closed", async () => {
  const { admin } = fakeAdmin({ begin: { data: [beginAttempt()], error: null } })
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    {
      getPayment: async () => approvedPayment({ external_reference: "999" }) as never,
      createRefund: async () => ({ kind: "confirmed", refund: { id: 1, payment_id: 9001, amount: 70000 } }),
    },
  )
  assert.deepEqual(result, { kind: "validation_failed", reason: "EXTERNAL_REFERENCE_MISMATCH" })
})

test("moneda distinta de ARS: fail-closed", async () => {
  const { admin } = fakeAdmin({ begin: { data: [beginAttempt()], error: null } })
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    {
      getPayment: async () => approvedPayment({ currency_id: "USD" }) as never,
      createRefund: async () => ({ kind: "confirmed", refund: { id: 1, payment_id: 9001, amount: 70000 } }),
    },
  )
  assert.deepEqual(result, { kind: "validation_failed", reason: "CURRENCY_MISMATCH" })
})

test("amount mismatch de exactamente 1 centavo: fail-closed (comparación en centavos, no floats)", async () => {
  const { admin } = fakeAdmin({ begin: { data: [beginAttempt({ amount: 70000 })], error: null } })
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    {
      getPayment: async () => approvedPayment({ transaction_amount: 70000.01 }) as never,
      createRefund: async () => ({ kind: "confirmed", refund: { id: 1, payment_id: 9001, amount: 70000 } }),
    },
  )
  assert.deepEqual(result, { kind: "validation_failed", reason: "AMOUNT_MISMATCH" })
})

test("payment ya refunded (según Mercado Pago): fail-closed, nunca reintenta", async () => {
  const { admin } = fakeAdmin({ begin: { data: [beginAttempt()], error: null } })
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    {
      getPayment: async () => approvedPayment({ transaction_amount_refunded: 70000 }) as never,
      createRefund: async () => ({ kind: "confirmed", refund: { id: 1, payment_id: 9001, amount: 70000 } }),
    },
  )
  assert.deepEqual(result, { kind: "validation_failed", reason: "PAYMENT_ALREADY_FULLY_REFUNDED" })
})

test("pedido no pagado por Mercado Pago / no elegible: begin() devuelve error, nunca se reconsulta a MP", async () => {
  const { admin } = fakeAdmin({ begin: { data: null, error: { message: "ORDER_NOT_PAID_BY_MERCADOPAGO" } } })
  let getPaymentCalled = false
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    { getPayment: async () => { getPaymentCalled = true; return approvedPayment() as never } },
  )
  assert.equal(result.kind, "validation_failed")
  assert.equal(getPaymentCalled, false)
})

test("refund ya 'processing' (doble click/otro admin): no vuelve a llamar a Mercado Pago", async () => {
  const { admin } = fakeAdmin({
    begin: { data: [beginAttempt({ should_call_mp: false, status: "processing" })], error: null },
  })
  let getPaymentCalled = false
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    { getPayment: async () => { getPaymentCalled = true; return approvedPayment() as never } },
  )
  assert.deepEqual(result, { kind: "in_progress", status: "processing" })
  assert.equal(getPaymentCalled, false)
})

test("refund ya confirmado: idempotente, no vuelve a llamar a Mercado Pago", async () => {
  const { admin } = fakeAdmin({
    begin: { data: [beginAttempt({ should_call_mp: false, status: "confirmed", mp_refund_id: "555" })], error: null },
  })
  let createRefundCalled = false
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    {
      getPayment: async () => approvedPayment() as never,
      createRefund: async () => { createRefundCalled = true; return { kind: "confirmed", refund: { id: 1, payment_id: 9001, amount: 70000 } } },
    },
  )
  assert.deepEqual(result, { kind: "already_confirmed" })
  assert.equal(createRefundCalled, false)
})

test("Mercado Pago rechaza el refund (respuesta definitiva): se registra como failed", async () => {
  const { admin, rpcCalls } = fakeAdmin({ begin: { data: [beginAttempt()], error: null } })
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    {
      getPayment: async () => approvedPayment() as never,
      createRefund: async () => ({ kind: "rejected", status: 400, code: "4020", message: "Payment already refunded" }),
    },
  )
  assert.deepEqual(result, { kind: "rejected", code: "4020", message: "Payment already refunded" })
  const recordCall = rpcCalls.find((c) => c.name === "record_mercadopago_order_refund_result")
  assert.equal(recordCall?.args.p_outcome, "failed")
})

test("timeout después del POST: needs_reconciliation, nunca se asume éxito ni fallo", async () => {
  const { admin, rpcCalls } = fakeAdmin({ begin: { data: [beginAttempt()], error: null } })
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    {
      getPayment: async () => approvedPayment() as never,
      createRefund: async () => ({ kind: "unknown", reason: "timeout esperando respuesta de Mercado Pago" }),
    },
  )
  assert.equal(result.kind, "unknown")
  const recordCall = rpcCalls.find((c) => c.name === "record_mercadopago_order_refund_result")
  assert.equal(recordCall?.args.p_outcome, "needs_reconciliation")
})

test("crash simulado tras aceptar MP el refund (getPayment falla en un intento posterior): igual queda needs_reconciliation, nunca un segundo POST ciego", async () => {
  const { admin, rpcCalls } = fakeAdmin({ begin: { data: [beginAttempt()], error: null } })
  const result = await refundMercadoPagoOrderPayment(
    admin as never,
    { orderId, adminId: "admin-1" },
    { getPayment: async () => { throw new Error("network down") } },
  )
  assert.equal(result.kind, "unknown")
  const recordCall = rpcCalls.find((c) => c.name === "record_mercadopago_order_refund_result")
  assert.equal(recordCall?.args.p_outcome, "needs_reconciliation")
  assert.equal(recordCall?.args.p_error_code, "PAYMENT_LOOKUP_FAILED")
})

test("reconciliación: Mercado Pago confirma el refund", async () => {
  const { admin, rpcCalls } = fakeAdmin({
    pendingRow: { id: "attempt-1", payment_id: paymentId, mp_refund_id: null },
  })
  const result = await reconcileMercadoPagoOrderRefund(
    admin as never,
    { orderId },
    { getRefundStatus: async () => ({ kind: "found", refund: { id: 555, payment_id: 9001, amount: 70000 } }) },
  )
  assert.deepEqual(result, { kind: "confirmed", mpRefundId: "555", amount: 70000 })
  const reconcileCall = rpcCalls.find((c) => c.name === "reconcile_mercadopago_order_refund")
  assert.equal(reconcileCall?.args.p_outcome, "confirmed")
})

test("reconciliación: Mercado Pago nunca recibió el refund -> vuelve a intentable", async () => {
  const { admin, rpcCalls } = fakeAdmin({
    pendingRow: { id: "attempt-1", payment_id: paymentId, mp_refund_id: null },
  })
  const result = await reconcileMercadoPagoOrderRefund(
    admin as never,
    { orderId },
    { getRefundStatus: async () => ({ kind: "not_found" }) },
  )
  assert.deepEqual(result, { kind: "not_found_yet" })
  const reconcileCall = rpcCalls.find((c) => c.name === "reconcile_mercadopago_order_refund")
  assert.equal(reconcileCall?.args.p_outcome, "requested")
})

test("reconciliación: sigue siendo ambiguo -> se mantiene needs_reconciliation, nunca dispara un POST", async () => {
  const { admin, rpcCalls } = fakeAdmin({
    pendingRow: { id: "attempt-1", payment_id: paymentId, mp_refund_id: null },
  })
  const result = await reconcileMercadoPagoOrderRefund(
    admin as never,
    { orderId },
    { getRefundStatus: async () => ({ kind: "unknown", reason: "timeout reconciliando" }) },
  )
  assert.equal(result.kind, "unknown")
  const reconcileCall = rpcCalls.find((c) => c.name === "reconcile_mercadopago_order_refund")
  assert.equal(reconcileCall?.args.p_outcome, "needs_reconciliation")
})

test("reconciliación sin ningún intento pendiente: no-op explícito", async () => {
  const { admin, rpcCalls } = fakeAdmin({ pendingRow: null })
  const result = await reconcileMercadoPagoOrderRefund(admin as never, { orderId })
  assert.deepEqual(result, { kind: "nothing_to_reconcile" })
  assert.equal(rpcCalls.length, 0)
})
