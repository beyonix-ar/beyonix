import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { processArcaInvoiceQueue } from "./invoice-automation.ts"
import { arcaAutoInvoicingView, isOrderInAutoInvoicingQueue } from "./auto-invoicing-control.ts"
import { getInvoiceFiscalStatusView } from "./invoice-status-view.ts"
import {
  FakeArca,
  applyAutoActivation,
  confirmOrder,
  enableAutoInvoicing,
  insertOrder,
  loadOrder,
  rpcClient,
  setupInvoicingDb,
} from "./fixtures/arca-invoicing-db.ts"

// Cadena pago confirmado → Factura C → (cancelación) → NC con las migraciones
// REALES de cola, worker y control automático (PostgreSQL embebido) y un
// ARCA simulado. Reproduce BX-1002: pago 22:30:31, automático apagado,
// cancelación 22:33:59 sin factura.

const ACTOR = "00000000-0000-4000-8000-000000000001"
const POINT = 3
const CONFIGURED = { configured: true, environment: "production", autoInvoicingEnabled: true } as const

type Db = Awaited<ReturnType<typeof setupInvoicingDb>>

// Requisito real de activación: una Factura C de producción emitida a mano.
const enableAutomatic = (db: Db) => enableAutoInvoicing(db, POINT, ACTOR)

async function control(db: Db) {
  const row = (await db.query<{ enabled: boolean; cutoff_at: Date | null; updated_at: Date }>(
    "select enabled, cutoff_at, updated_at from arca_auto_invoicing_control where id",
  )).rows[0]
  return arcaAutoInvoicingView({
    enabled: row.enabled,
    cutoff_at: row.cutoff_at ? new Date(row.cutoff_at).toISOString() : null,
    updated_at: new Date(row.updated_at).toISOString(),
  }, CONFIGURED as never)
}

const asQueueOrder = (order: Record<string, unknown>) => ({
  ...order,
  invoice_queued_at: order.invoice_queued_at ? new Date(String(order.invoice_queued_at)).toISOString() : null,
  invoice_next_attempt_at: order.invoice_next_attempt_at ? new Date(String(order.invoice_next_attempt_at)).toISOString() : null,
}) as never

// Comportamiento real de BX-1002 con las migraciones PREVIAS a 20261014100000
// (la carrera que corrige invoice-obligation-survives-cancellation.test.ts).
test("BX-1002 (antes de 20261014100000): automático apagado → se encola, el job no lo toma y cancelar lo sacaba de la cola", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT, "production")
  try {
    await applyAutoActivation(db)
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    const queued = await loadOrder(db, id)
    assert.equal(queued.invoice_status, "pending", "el pago confirmado entra a la cola")
    assert.ok(queued.invoice_queued_at)

    const run = await processArcaInvoiceQueue(rpcClient(db), { gateway: arca, pointOfSale: POINT })
    assert.equal(run.results.length, 0, "control apagado: el worker no toma nada")
    assert.equal(arca.requests, 0)
    assert.equal(Number((await loadOrder(db, id)).invoice_attempts), 0)

    // Admin: nunca promete una emisión automática que no va a ocurrir.
    const automatic = isOrderInAutoInvoicingQueue(await control(db), asQueueOrder(await loadOrder(db, id)))
    assert.equal(automatic, false)
    const view = getInvoiceFiscalStatusView(await loadOrder(db, id) as never, automatic)
    assert.doesNotMatch(view?.description ?? "", /se emite automáticamente/)
    assert.match(view?.description ?? "", /facturación automática está desactivada/)

    // Cancelación antes de facturar: sale de la cola, sin comprobante ni NC.
    await db.query("update ordenes set estado='cancelado', financial_status='refund_pending', cancelled_at=now() where id=$1", [id])
    const cancelled = await loadOrder(db, id)
    assert.equal(cancelled.invoice_status, null)
    assert.equal(cancelled.invoice_cae, null)
    assert.equal(cancelled.credit_note_required, false, "sin factura no se inventa NC")
  } finally { await db.close() }
})

test("automático activo: pago confirmado → el job emite UNA Factura C; corridas repetidas y webhook repetido no duplican", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT, "production")
  try {
    await applyAutoActivation(db)
    await enableAutomatic(db)
    arca.vouchers.set(1, { total: 1000, cae: "CAE-MANUAL", caeDue: "20261130", date: "20261013" })
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    const view = await control(db)
    const queued = asQueueOrder(await loadOrder(db, id))
    assert.equal(isOrderInAutoInvoicingQueue(view, queued), true, "Admin la muestra como automática")

    const client = rpcClient(db)
    const first = await processArcaInvoiceQueue(client, { gateway: arca, pointOfSale: POINT })
    assert.equal(first.authorized, 1)
    const invoiced = await loadOrder(db, id)
    assert.equal(invoiced.invoice_status, "authorized")
    assert.ok(invoiced.invoice_cae)
    assert.equal(Number(invoiced.invoice_number), 2)

    // Idempotencia: otra corrida del timer y un webhook de pago repetido.
    assert.equal((await processArcaInvoiceQueue(client, { gateway: arca, pointOfSale: POINT })).results.length, 0)
    await confirmOrder(db, id)
    assert.equal((await processArcaInvoiceQueue(client, { gateway: arca, pointOfSale: POINT })).results.length, 0)
    assert.equal(arca.requests, 1, "un solo FECAESolicitar")
    assert.equal(Number((await loadOrder(db, id)).invoice_number), 2)
    assert.equal(getInvoiceFiscalStatusView(await loadOrder(db, id) as never, true), null, "facturado: sin aviso pendiente")
  } finally { await db.close() }
})

test("error de ARCA con automático activo: queda en error con reintento programado y luego se emite sin duplicar", async () => {
  const db = await setupInvoicingDb()
  const arca = new FakeArca(POINT, "production")
  try {
    await applyAutoActivation(db)
    await enableAutomatic(db)
    arca.vouchers.set(1, { total: 1000, cae: "CAE-MANUAL", caeDue: "20261130", date: "20261013" })
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    arca.down = true
    const client = rpcClient(db)
    assert.equal((await processArcaInvoiceQueue(client, { gateway: arca, pointOfSale: POINT })).failed, 1)
    const failed = await loadOrder(db, id)
    assert.equal(failed.invoice_status, "error")
    assert.ok(failed.invoice_next_attempt_at, "reintento programado")
    assert.ok(failed.invoice_error)
    assert.equal(failed.financial_status, "payment_confirmed", "el pago sigue confirmado")
    assert.match(getInvoiceFiscalStatusView(failed as never, true)?.description ?? "", /Se reintenta automáticamente/)

    arca.down = false
    await db.query("update ordenes set invoice_next_attempt_at = now() - interval '1 second' where id=$1", [id])
    assert.equal((await processArcaInvoiceQueue(client, { gateway: arca, pointOfSale: POINT })).authorized, 1)
    assert.equal((await loadOrder(db, id)).invoice_status, "authorized")
    assert.equal([...arca.vouchers.keys()].filter((number) => number > 1).length, 1, "un único CAE para la venta")
  } finally { await db.close() }
})

test("factura → cancelación → NC: el circuito que permite cancelar una venta facturada exige NC; Admin directo no cancela facturadas", () => {
  const read = (path: string) => readFileSync(path, "utf8")
  // Cancelación por el cliente/reclamo (camino de una venta ya facturada).
  const customer = read("supabase/migrations/20260917110000_fix_customer_cancellation_type_and_null_bugs.sql")
  assert.match(customer, /credit_note_required = v_payment_confirmed and v_invoiced/)
  // Cancelación directa de Admin: bloquea facturadas (por eso deja NC en false sin riesgo).
  const adminCancel = read("supabase/migrations/20260916100000_block_cancellation_during_andreani_creation.sql")
  const adminBody = adminCancel.slice(adminCancel.indexOf("create or replace function public.admin_cancel_order("))
  assert.match(adminBody, /invoice_status in \('authorized', 'processing'\)[\s\S]*?raise exception 'ORDER_ALREADY_INVOICED'/)
  // CAE que llega con la venta ya cancelada: también pide NC.
  const worker = read("supabase/migrations/20260927120000_arca_environment_isolation.sql")
  assert.match(worker, /credit_note_required = case when v_cancellation_flow then true else credit_note_required end/)
  // La resolución financiera emite la NC sólo si corresponde (nunca sin factura).
  const resolution = read("lib/orders/financial-resolution-server.ts")
  assert.match(resolution, /if \(!context\.order\.credit_note_required && context\.notes\.length === 0\) return/)
})
