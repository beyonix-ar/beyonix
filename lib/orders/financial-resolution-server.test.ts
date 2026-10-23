import assert from "node:assert/strict"
import test from "node:test"

import { loadFinancialResolution } from "./financial-resolution-server"

// Hechos del orquestador para una venta cancelada, cobrada por transferencia
// ($899) y con Factura C: la cancelación del cliente (reclamo aprobado) y la de
// Super Admin (order_has_admin_direct_cancellation) entran al mismo circuito
// Saldo/Reintegro → NC. Sin evidencia de cancelación, la NC pendiente sigue
// siendo un caso avanzado real.

type Rows = Record<string, readonly unknown[]>

function fakeAdmin(rows: Rows, directCancellation: boolean) {
  const admin = {
    from(table: string) {
      const result = { data: rows[table] ?? [], error: null }
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows[table]?.[0] ?? null, error: null }),
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      }
      return chain
    },
    rpc(name: string) {
      const data = name === "order_has_admin_direct_cancellation" ? directCancellation : null
      return Promise.resolve({ data, error: null })
    },
  }
  return admin as unknown as Parameters<typeof loadFinancialResolution>[0]
}

const cancelledInvoicedTransfer = {
  id: 14, usuario_id: "10000000-0000-4000-8000-000000000001", estado: "cancelado", financial_status: "refund_pending",
  payment_method_id: "transferencia", payment_status: "confirmado", paid_at: "2026-10-20T12:00:00Z", payment_id: null,
  payment_confirmed_amount: 899, external_amount_due: 899, invoice_status: "authorized", invoice_cae: "CAE",
  invoice_queued_at: "2026-10-20T12:00:00Z", credit_note_required: true, andreani_handed_over_at: null,
  tracking_number: null, andreani_tracking: null, andreani_envio_id: null, andreani_estado: null,
  mercadopago_reference: null, mercadopago_reference_assigned_at: null, credit_balance_used: 0,
  original_total: 899, total: 899, shipping_cost_charged: 0,
}
const approvedCancellationClaim = { id: 5, status: "aprobado", failure_type: "cancelar_compra", resolution: "reintegro" }

for (const [label, rows, direct] of [
  ["A. cancelación del cliente", { ordenes: [cancelledInvoicedTransfer], order_claims: [approvedCancellationClaim] }, false],
  ["B. cancelación de Super Admin", { ordenes: [cancelledInvoicedTransfer] }, true],
] as const) {
  test(`${label}: stock resuelto → Saldo o Reintegro por $899, sin modo avanzado`, async () => {
    const context = await loadFinancialResolution(fakeAdmin(rows, direct), 14, false)
    assert.ok(context)
    assert.equal(context.mode, "wizard", "I: nunca cae al ajuste administrativo")
    assert.equal(context.amount, 899, "monto canónico del pago, no editable")
    assert.deepEqual(context.options.map((option) => option.type), ["beyonix_credit", "manual_refund"])
    assert.equal(context.adminDirectCancellation, direct)
  })
}

test("H. retención física activa: sin opciones hasta resolver el stock", async () => {
  const context = await loadFinancialResolution(fakeAdmin({
    ordenes: [cancelledInvoicedTransfer],
    order_cancellation_holds: [{ detected_at: "2026-10-21T10:00:00Z", resolved_at: null }],
  }, true), 14, false)
  assert.ok(context)
  assert.equal(context.physicalHoldActive, true)
  assert.deepEqual(context.options, [])
})

test("J. NC exigida sin reclamo ni cancelación directa: sigue siendo caso avanzado", async () => {
  const context = await loadFinancialResolution(fakeAdmin({ ordenes: [cancelledInvoicedTransfer] }, false), 14, false)
  assert.ok(context)
  assert.equal(context.mode, "advanced")
  assert.deepEqual(context.options, [])
})
