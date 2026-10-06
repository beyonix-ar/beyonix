import assert from "node:assert/strict"
import test from "node:test"

import {
  detectTransferPaymentsAfterCancellation,
  TRANSFER_CANCELLED_WITHOUT_PAYMENT_STATUSES,
  TRANSFER_PAYMENT_AFTER_CANCELLATION_STATUS,
} from "./transfer-payment-after-cancellation.ts"
import { getAdminPendingOrderActions } from "./admin-pending-actions.ts"
import type { MercadoPagoBankTransferCandidate } from "../mercadopago/bank-transfer-search.ts"

const NOW = new Date("2026-09-26T15:00:00.000Z")

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    created_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    cliente_email: "cliente@example.com",
    cliente_nombre: "Martín Núñez",
    transfer_payer_dni: "30111222",
    transfer_amount_declared: 700,
    transfer_last_verification_at: null,
    ...overrides,
  }
}

function payment(overrides: Partial<MercadoPagoBankTransferCandidate> = {}): MercadoPagoBankTransferCandidate {
  return {
    id: "pay-late-1",
    status: "approved",
    operationType: "money_transfer",
    paymentMethodId: "account_money",
    transactionAmount: 700,
    currencyId: "ARS",
    dateCreated: NOW.toISOString(),
    dateApproved: NOW.toISOString(),
    identificationType: "CUIL",
    identificationNumber: "20301112220",
    bankTransferId: null,
    ...overrides,
  } as MercadoPagoBankTransferCandidate
}

function createFakeAdmin(rows: Array<Record<string, unknown>>, { claimWins = true } = {}) {
  const calls: Array<{ table: string; kind: string; filters: unknown[][]; payload?: unknown }> = []
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = {
    from(table: string) {
      const call = { table, kind: "select", filters: [] as unknown[][], payload: undefined as unknown }
      calls.push(call)
      const chain: Record<string, unknown> = {}
      for (const method of ["eq", "in", "is", "not", "gt", "or", "neq"]) {
        chain[method] = (...args: unknown[]) => { call.filters.push([method, ...args]); return chain }
      }
      chain.select = () => chain
      chain.update = (payload: unknown) => { call.kind = "update"; call.payload = payload; return chain }
      chain.order = () => chain
      chain.limit = () => Promise.resolve({ data: rows, error: null })
      chain.maybeSingle = () => Promise.resolve({ data: claimWins ? { id: 41 } : null, error: null })
      // loadPaymentIdsClaimedByOtherOrders: nada reclamado por otros pedidos.
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null })
      return chain
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      return Promise.resolve({ data: {}, error: null })
    },
  }
  return { admin: client as never, calls, rpcCalls }
}

const deps = (candidates: MercadoPagoBankTransferCandidate[], notified: string[] = []) => ({
  now: () => NOW,
  searchTransfers: async () => ({ candidates, exhaustive: true }) as never,
  notify: async ({ subject }: { subject: string }) => { notified.push(subject) },
})

test("P2: una transferencia real de un pedido cancelado sin pago se REGISTRA (sin confirmar) y se avisa al cliente", async () => {
  const { admin, calls, rpcCalls } = createFakeAdmin([candidateRow()])
  const notified: string[] = []
  const result = await detectTransferPaymentsAfterCancellation(admin, deps([payment()], notified) as never)

  assert.deepEqual(result, { searched: 1, detected: 1 })
  assert.equal(rpcCalls.length, 1)
  assert.equal(rpcCalls[0].name, "record_transfer_payment_after_cancellation", "nunca confirm_transfer_auto_verification")
  assert.equal(rpcCalls[0].args.p_matched_payment_id, "pay-late-1")
  assert.equal(rpcCalls[0].args.p_matched_amount, 700)
  assert.deepEqual(notified, ["Recibimos tu transferencia BX-1041"])

  const load = calls[0]
  const filters = JSON.stringify(load.filters)
  assert.ok(filters.includes('["eq","estado","cancelado"]'))
  assert.ok(filters.includes(JSON.stringify(["in", "payment_status", [...TRANSFER_CANCELLED_WITHOUT_PAYMENT_STATUSES]])))
  assert.ok(filters.includes('["is","transfer_matched_payment_id",null]'))
  assert.ok(filters.includes('["gt","created_at"'), "sólo dentro de la ventana técnica de 48 h")
  const claim = calls.find((call) => call.kind === "update")
  assert.deepEqual(claim?.payload, { transfer_last_verification_at: NOW.toISOString() }, "el turno de búsqueda se reclama atómicamente")
})

test("P2: matching estricto -- otro DNI, otro monto o candidatos ambiguos no registran nada", async () => {
  for (const candidates of [
    [payment({ identificationNumber: "20999999990" })],
    [payment({ transactionAmount: 900 })],
    [payment(), payment({ id: "pay-late-2" })],
  ]) {
    const { admin, rpcCalls } = createFakeAdmin([candidateRow()])
    const result = await detectTransferPaymentsAfterCancellation(admin, deps(candidates) as never)
    assert.equal(result.detected, 0)
    assert.equal(rpcCalls.length, 0)
  }
})

test("P2: si otra corrida ya tomó el pedido, no se consulta Mercado Pago ni se registra dos veces", async () => {
  const { admin, rpcCalls } = createFakeAdmin([candidateRow()], { claimWins: false })
  let searches = 0
  const result = await detectTransferPaymentsAfterCancellation(admin, {
    now: () => NOW,
    searchTransfers: async () => { searches += 1; return { candidates: [payment()], exhaustive: true } as never },
    notify: async () => {},
  } as never)
  assert.deepEqual(result, { searched: 0, detected: 0 })
  assert.equal(searches, 0)
  assert.equal(rpcCalls.length, 0)
})

test("P2: Admin lo ve como pago cobrado sin confirmar (acción urgente), sin ofrecer facturar ni enviar", () => {
  const actions = getAdminPendingOrderActions({
    id: 41,
    estado: "cancelado",
    payment_method_id: "transferencia",
    payment_status: TRANSFER_PAYMENT_AFTER_CANCELLATION_STATUS,
    financial_status: "cancelled",
    transfer_verification_status: "manual_review",
    total: 900,
  } as never)
  assert.deepEqual(
    actions.filter((action) => action.kind === "payment_conflict"),
    [{ kind: "payment_conflict", label: "Resolver pago", urgent: true, priority: 1, href: "/admin/pedidos/41?tab=pago" }],
  )
  assert.ok(!actions.some((action) => action.kind === "invoice" || action.kind === "shipping"))
})
