import assert from "node:assert/strict"
import test from "node:test"

import { getCancellationProgress } from "../admin/order-operational-progress.ts"
import { refundMercadoPagoOrderPayment, reconcileRefundAttempt } from "../mercadopago/order-refund.ts"
import { getMercadoPagoRefundStatus } from "../mercadopago/refunds.ts"
import { getCancellationNextAction, type CancellationNextActionOrder } from "./cancellation-next-action.ts"
import { getCancellationPanelViewModel } from "./cancellation-panel-view.ts"
import {
  FINANCIAL_STALE_RESERVATION_MS, financialHumanStatus, getEffectiveFinancialResolutionStatus,
} from "./financial-resolution.ts"

// Auditoría del circuito Pago → Factura C → Cancelación → NC → Reintegro
// (15/10/2026). Cada bloque reproduce un hallazgo concreto.

const cancelledMercadoPago = (overrides: Partial<CancellationNextActionOrder> = {}): CancellationNextActionOrder => ({
  estado: "cancelado",
  financial_status: "refund_pending",
  payment_method_id: "mercadopago",
  payment_status: "approved",
  paid_at: "2026-10-14T03:23:38Z",
  payment_confirmed_amount: 1000,
  invoice_status: "authorized",
  invoice_cae: "86417601175734",
  invoice_queued_at: "2026-10-14T03:23:39Z",
  credit_note_required: false,
  order_credit_notes: [{ status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 1000, external_amount: 1000 }],
  mercadopago_order_refunds: [],
  ...overrides,
})

test("MP con NC total autorizada: la acción es el refund real, nunca 'cargar comprobante'", () => {
  // commit_order_refund_proof rechaza Mercado Pago (MERCADOPAGO_REQUIRES_REAL_REFUND).
  assert.deepEqual(getCancellationNextAction(cancelledMercadoPago()), { state: "execute_mp_refund", urgent: true })
  // Un intento fallido (rechazo/error de MP) se puede reintentar.
  assert.equal(getCancellationNextAction(cancelledMercadoPago({
    mercadopago_order_refunds: [{ status: "failed", created_at: "2026-10-14T03:29:53Z" }],
  })).state, "execute_mp_refund")
  // Refund en curso: no se ofrece otro (doble click / segundo admin).
  assert.equal(getCancellationNextAction(cancelledMercadoPago({
    mercadopago_order_refunds: [{ status: "processing", created_at: "2026-10-14T03:29:53Z" }],
  })).state, "none")
  // Pago combinado: la NC fiscal ($1.500) incluye saldo; su parte externa ($1.000) cubre lo cobrado por MP.
  assert.equal(getCancellationNextAction(cancelledMercadoPago({
    order_credit_notes: [{ status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 1500, external_amount: 1000 }],
  })).state, "execute_mp_refund")
})

test("MP con NC parcial: se reintegra a mano por la parte autorizada (no hay refund parcial MP)", () => {
  const partial = cancelledMercadoPago({
    order_credit_notes: [{ status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 400, external_amount: 400 }],
  })
  assert.equal(getCancellationNextAction(partial).state, "register_external_refund")
  assert.equal(getCancellationPanelViewModel({ ...partial, total: 1000 }).amounts.amountToRefund, 400, "NC parcial nunca se interpreta como total")
})

test("transferencia con NC autorizada: queda 'reintegro por transferencia pendiente' hasta el comprobante", () => {
  const transfer = cancelledMercadoPago({ payment_method_id: "transferencia" })
  const model = getCancellationPanelViewModel({ ...transfer, total: 1000 })
  assert.equal(model.state, "register_external_refund")
  assert.equal(model.isFinished, false)
  assert.match(model.helperText, /Reintegro por transferencia pendiente/)
})

test("caso heredado (pedido #2): reintegrado sin NC no se muestra como 'Proceso finalizado'", () => {
  const legacy = {
    estado: "cancelado", financial_status: "refunded", payment_method_id: "mercadopago", payment_status: "refunded",
    paid_at: "2026-10-13T22:30:30Z", payment_confirmed_amount: 1000, total: 1000,
    invoice_status: "authorized", invoice_cae: "86417596112941", invoice_queued_at: "2026-10-13T22:30:31Z",
    credit_note_required: true, order_credit_notes: [],
    mercadopago_order_refunds: [{ status: "confirmed", created_at: "2026-10-13T22:42:30Z" }],
  }
  const model = getCancellationPanelViewModel(legacy)
  assert.equal(model.state, "completed", "el dinero ya volvió: no hay otro reintegro")
  assert.equal(model.creditNotePending, true)
  assert.equal(model.badgeTone, "warning")
  assert.doesNotMatch(model.helperText, /No hay más acciones pendientes/)
  assert.equal(model.steps.find((step) => step.key === "credit_note")?.status, "attention")
  // El progreso del pedido usa la misma verdad: NC pendiente, reintegro hecho.
  assert.deepEqual(getCancellationProgress(legacy), [
    { label: "Nota de crédito", complete: false },
    { label: "Reintegro", complete: true },
  ])

  // Con la NC heredada autorizada, el proceso queda cerrado sin contradicciones.
  const closed = getCancellationPanelViewModel({ ...legacy, credit_note_required: false,
    order_credit_notes: [{ status: "authorized", destination: "none", settlement_status: "completado", total_amount: 1000 }] })
  assert.equal(closed.creditNotePending, false)
  assert.equal(closed.badgeTone, "success")
  assert.match(closed.helperText, /No hay más acciones pendientes/)
})

test("resolución con lease vencido o reserva cortada: requiere reintento, no 'En proceso' eterno", () => {
  const now = Date.parse("2026-10-15T12:00:00Z")
  const live = { status: "processing", lease_until: "2026-10-15T12:03:00Z" }
  const expired = { status: "processing", lease_until: "2026-10-15T11:59:00Z" }
  assert.equal(getEffectiveFinancialResolutionStatus(live, now), "processing")
  assert.equal(getEffectiveFinancialResolutionStatus(expired, now), "requires_action")
  assert.equal(getEffectiveFinancialResolutionStatus({ status: "processing", lease_until: null }, now), "requires_action")
  assert.equal(getEffectiveFinancialResolutionStatus({ status: "reserved", updated_at: new Date(now - 1000).toISOString() }, now), "reserved")
  assert.equal(getEffectiveFinancialResolutionStatus({ status: "reserved", updated_at: new Date(now - FINANCIAL_STALE_RESERVATION_MS - 1).toISOString() }, now), "requires_action")
  for (const status of ["completed", "manual_pending", "requires_action"]) {
    assert.equal(getEffectiveFinancialResolutionStatus({ status, lease_until: null }, now), status, "estados finales/humanos no cambian")
  }
  assert.equal(financialHumanStatus(getEffectiveFinancialResolutionStatus(expired, now)), "Requiere acción")
})

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

test("conciliación sin id de refund: sólo un refund por el importe del intento es el nuestro", async () => {
  process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-token"
  const list = [{ id: 11, payment_id: 9001, amount: 300 }, { id: 12, payment_id: 9001, amount: 1000 }]
  const fetchList = (async () => jsonResponse(list)) as unknown as typeof fetch
  const matched = await getMercadoPagoRefundStatus("9001", null, fetchList, 1000)
  assert.equal(matched.kind === "found" && matched.refund.id, 12)
  // Sólo hay un refund parcial hecho a mano en MP: nunca confirma el intento total.
  const external = await getMercadoPagoRefundStatus("9001", null, (async () => jsonResponse([list[0]])) as unknown as typeof fetch, 1000)
  assert.equal(external.kind, "unknown")
  // MP no tiene ningún refund: el POST nunca se procesó.
  assert.equal((await getMercadoPagoRefundStatus("9001", null, (async () => jsonResponse([])) as unknown as typeof fetch, 1000)).kind, "not_found")
})

function fakeAdmin(failRpc: string | null) {
  const rpcCalls: string[] = []
  const admin = {
    rpc: async (name: string) => {
      rpcCalls.push(name)
      if (name === "begin_mercadopago_order_refund") {
        return { data: [{ refund_id: "attempt-1", payment_id: "9001", amount: 1000, idempotency_key: "k", status: "processing", should_call_mp: true, mp_refund_id: null }], error: null }
      }
      return name === failRpc ? { data: null, error: { message: "connection reset" } } : { data: {}, error: null }
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 1, mercadopago_reference: null, mercadopago_reference_assigned_at: null }, error: null }) }) }) }),
  }
  return { admin: admin as never, rpcCalls }
}

test("MP confirma pero BEYONIX no pudo registrarlo: nunca se informa cerrado ni se repite el POST", async () => {
  const originalError = console.error
  console.error = () => {}
  try {
    const { admin, rpcCalls } = fakeAdmin("record_mercadopago_order_refund_result")
    let posts = 0
    const result = await refundMercadoPagoOrderPayment(admin, { orderId: 1, adminId: "admin" }, {
      getPayment: async () => ({ id: 9001, status: "approved", external_reference: "1", currency_id: "ARS", transaction_amount: 1000, transaction_amount_refunded: 0 }) as never,
      createRefund: async () => { posts += 1; return { kind: "confirmed", refund: { id: 555, payment_id: 9001, amount: 1000 } as never } },
    })
    assert.deepEqual(result, { kind: "unknown", reason: "REFUND_RESULT_NOT_PERSISTED" })
    assert.equal(posts, 1)
    assert.deepEqual(rpcCalls, ["begin_mercadopago_order_refund", "record_mercadopago_order_refund_result"])

    // La conciliación posterior confirma por GET con el importe del intento.
    const reconcile = fakeAdmin(null)
    const amounts: Array<number | null | undefined> = []
    const reconciled = await reconcileRefundAttempt(reconcile.admin, { id: "attempt-1", payment_id: "9001", mp_refund_id: null, amount: "1000.00" }, {
      getRefundStatus: async (_paymentId, _refundId, expectedAmount) => { amounts.push(expectedAmount); return { kind: "found", refund: { id: 555, payment_id: 9001, amount: 1000 } as never } },
    })
    assert.equal(reconciled.kind, "confirmed")
    assert.deepEqual(amounts, [1000])
    assert.deepEqual(reconcile.rpcCalls, ["reconcile_mercadopago_order_refund"])

    const failedReconcile = await reconcileRefundAttempt(fakeAdmin("reconcile_mercadopago_order_refund").admin,
      { id: "attempt-1", payment_id: "9001", mp_refund_id: "555", amount: 1000 },
      { getRefundStatus: async () => ({ kind: "found", refund: { id: 555, payment_id: 9001, amount: 1000 } as never }) })
    assert.equal(failedReconcile.kind, "unknown", "sin persistir no se informa confirmado")
  } finally {
    console.error = originalError
  }
})
