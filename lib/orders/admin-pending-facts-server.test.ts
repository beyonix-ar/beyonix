import assert from "node:assert/strict"
import test from "node:test"

import { loadAdminPendingFacts } from "./admin-pending-facts-server"

type Rows = Record<string, unknown[]>

/** Cliente mínimo: cada tabla devuelve sus filas; registra qué se consultó. */
function fakeAdmin(rows: Rows) {
  const queried: string[] = []
  const admin = {
    from(table: string) {
      queried.push(table)
      const result = { data: rows[table] ?? [], error: null }
      const chain = {
        select: () => chain,
        in: () => chain,
        is: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows[table]?.[0] ?? null, error: null }),
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      }
      return chain
    },
  }
  return { admin: admin as unknown as Parameters<typeof loadAdminPendingFacts>[0], queried }
}

test("despacho: bloqueo vigente, cancelado dentro de tanda y tanda cerrada", async () => {
  const { admin, queried } = fakeAdmin({
    order_packages: [{ order_id: 1, status: "prepared" }, { order_id: 2, status: "prepared" }],
    dispatch_batch_items: [
      { order_id: 1, batch_id: 7, dispatch_batches: { status: "closed" } },
      { order_id: 2, batch_id: 7, dispatch_batches: { status: "closed" } },
      { order_id: 3, batch_id: 8, dispatch_batches: { status: "open" } },
    ],
    dispatch_blocks: [{ order_id: 1 }],
  })
  const facts = await loadAdminPendingFacts(admin, [
    { id: 1, financial_status: "payment_confirmed" },
    { id: 2, financial_status: "payment_confirmed", cancelled_at: "2026-10-05T10:00:00Z" },
    { id: 3, financial_status: "payment_confirmed" },
    { id: 4, financial_status: "payment_confirmed" },
  ], false)
  assert.deepEqual(facts.get(1)?.dispatch, { batchId: 7, batchStatus: "closed", packageStatus: "prepared", blocked: true })
  assert.equal(facts.get(2)?.dispatch?.blocked, true, "cancelado dentro de la tanda: retirarlo")
  assert.deepEqual(facts.get(3)?.dispatch, { batchId: 8, batchStatus: "open", packageStatus: null, blocked: false })
  assert.deepEqual(facts.get(4)?.dispatch, { batchId: null, batchStatus: null, packageStatus: null, blocked: false })
  // Operador: sin datos financieros ni consulta al orquestador.
  assert.equal(facts.get(1)?.financial, null)
  assert.ok(!queried.includes("order_financial_resolutions"))
  assert.ok(!queried.includes("ordenes"))
})

test("financiero: sólo los pedidos con dinero por resolver pasan por el orquestador", async () => {
  const { admin, queried } = fakeAdmin({})
  const facts = await loadAdminPendingFacts(admin, [{ id: 5, financial_status: "payment_confirmed" }], true)
  assert.ok(queried.includes("order_financial_resolutions"))
  assert.ok(!queried.includes("ordenes"), "sin refund_pending ni resolución: no se carga el orquestador")
  assert.equal(facts.get(5)?.financial, null)
})

test("factura en cola: automática sólo con el control y la configuración ARCA reales activos", async () => {
  const queued = {
    id: 6, financial_status: "payment_confirmed", invoice_status: "pending", invoice_cae: null, invoice_number: null,
    invoice_next_attempt_at: "2026-10-05T12:00:00Z", invoice_queued_at: "2026-10-05T11:00:00Z", invoice_arca_environment: null,
  }
  const previous = process.env.ARCA_AUTO_INVOICING_ENABLED
  try {
    // Control activado en Admin pero el servidor no tiene el automático habilitado/configurado.
    process.env.ARCA_AUTO_INVOICING_ENABLED = "true"
    const enabledControl = fakeAdmin({ arca_auto_invoicing_control: [{ enabled: true, cutoff_at: "2026-10-03T15:00:00Z", updated_at: "2026-10-03T15:00:00Z" }] })
    assert.equal((await loadAdminPendingFacts(enabledControl.admin, [queued], true)).get(6)?.invoiceAutomatic, false)
    assert.ok(enabledControl.queried.includes("arca_auto_invoicing_control"))
    // Sin fila de control: nunca se asume automático.
    const missing = fakeAdmin({})
    assert.equal((await loadAdminPendingFacts(missing.admin, [queued], false)).get(6)?.invoiceAutomatic, false)
  } finally {
    if (previous === undefined) delete process.env.ARCA_AUTO_INVOICING_ENABLED
    else process.env.ARCA_AUTO_INVOICING_ENABLED = previous
  }
})

test("lista vacía: sin consultas", async () => {
  const { admin, queried } = fakeAdmin({})
  assert.equal((await loadAdminPendingFacts(admin, [], true)).size, 0)
  assert.deepEqual(queried, [])
})
