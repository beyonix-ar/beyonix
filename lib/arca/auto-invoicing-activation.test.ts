import assert from "node:assert/strict"
import test from "node:test"

import { argentinaDate, processArcaInvoice, processArcaInvoiceQueue } from "./invoice-automation.ts"
import {
  FakeArca,
  applyAutoActivation,
  confirmOrder,
  insertOrder,
  loadOrder,
  rpcClient,
  setupInvoicingDb,
} from "./fixtures/arca-invoicing-db.ts"

const ACTOR = "00000000-0000-4000-8000-000000000001"
const POINT = 3

async function firstManualProductionInvoice(db: Awaited<ReturnType<typeof setupInvoicingDb>>) {
  const id = await insertOrder(db)
  await confirmOrder(db, id)
  await db.query(
    `update ordenes set invoice_status='authorized', invoice_arca_environment='production',
       invoice_cae='CAE-MANUAL', invoice_point=$2, invoice_number=1 where id=$1`,
    [id, POINT],
  )
  await db.query(
    `insert into order_audit_events (order_id, actor_type, action, metadata)
     values ($1, 'system', 'arca_invoice_attempt_started', '{"manual": true}'::jsonb)`,
    [id],
  )
  return id
}

async function setAutomatic(db: Awaited<ReturnType<typeof setupInvoicingDb>>, enabled: boolean) {
  const { rows } = await db.query<{ enabled: boolean; cutoff_at: Date | null }>(
    "select * from set_arca_auto_invoicing($1, $2)",
    [enabled, ACTOR],
  )
  return rows[0]
}

test("automático apagado y primera factura manual obligatoria; backlog y homologación quedan intactos", async () => {
  const db = await setupInvoicingDb()
  try {
    await applyAutoActivation(db)
    const old = await insertOrder(db)
    await confirmOrder(db, old)
    await db.query("select set_config('request.jwt.claim.role','anon',false)")
    await assert.rejects(setAutomatic(db, true), /FORBIDDEN/)
    await db.query("select set_config('request.jwt.claim.role','service_role',false)")
    const historicalIssued = await insertOrder(db)
    await confirmOrder(db, historicalIssued)
    await db.query(
      "update ordenes set invoice_status='authorized', invoice_arca_environment='homologation', invoice_cae='CAE-PRUEBA', invoice_point=$2, invoice_number=1 where id=$1",
      [historicalIssued, POINT],
    )
    assert.equal((await db.query("select * from claim_arca_invoice(null)")).rows.length, 0)
    assert.equal((await db.query("select * from claim_arca_invoice($1, interval '10 minutes', null)", [old])).rows.length, 0)
    assert.equal((await loadOrder(db, old)).invoice_status, "pending")
    await assert.rejects(setAutomatic(db, true), /ARCA_FIRST_MANUAL_INVOICE_REQUIRED/)

    const manual = await firstManualProductionInvoice(db)
    const first = await setAutomatic(db, true)
    assert.equal(first.enabled, true)
    assert.ok(first.cutoff_at)
    const repeated = await setAutomatic(db, true)
    assert.equal(String(repeated.cutoff_at), String(first.cutoff_at), "activar dos veces no mueve el cutoff")

    const homologation = await insertOrder(db)
    await confirmOrder(db, homologation)
    await db.query("update ordenes set invoice_arca_environment='homologation' where id=$1", [homologation])
    const historicalNumber = await insertOrder(db)
    await confirmOrder(db, historicalNumber)
    await db.query("update ordenes set invoice_arca_environment='homologation', invoice_number=77 where id=$1", [historicalNumber])
    const fresh = await insertOrder(db)
    await confirmOrder(db, fresh)

    const claimed = (await db.query<{ id: number }>("select * from claim_arca_invoice(null)")).rows
    assert.equal(Number(claimed[0]?.id), fresh, "sólo el pedido nuevo de producción")
    assert.equal((await loadOrder(db, old)).invoice_status, "pending")
    assert.equal((await loadOrder(db, homologation)).invoice_status, "pending")
    assert.equal((await loadOrder(db, historicalNumber)).invoice_status, "pending")
    assert.equal((await loadOrder(db, historicalIssued)).invoice_status, "authorized")
    assert.equal((await loadOrder(db, manual)).invoice_status, "authorized")
    assert.equal((await db.query("select * from claim_arca_invoice(null)")).rows.length, 0, "dos runners no toman otro pedido")

    const events = (await db.query<{ enabled: boolean }>("select enabled from arca_auto_invoicing_events order by id")).rows
    assert.deepEqual(events.map((event) => event.enabled), [true])
  } finally {
    await db.close()
  }
})

test("desactivación detiene claims; reactivación fija otro cutoff y no recupera el período apagado", async () => {
  const db = await setupInvoicingDb()
  try {
    await applyAutoActivation(db)
    await firstManualProductionInvoice(db)
    const first = await setAutomatic(db, true)
    const whileActive = await insertOrder(db)
    await confirmOrder(db, whileActive)
    await setAutomatic(db, false)
    assert.equal((await db.query("select * from claim_arca_invoice(null)")).rows.length, 0)
    const whileOff = await insertOrder(db)
    await confirmOrder(db, whileOff)
    const second = await setAutomatic(db, true)
    assert.ok(new Date(second.cutoff_at!).getTime() > new Date(first.cutoff_at!).getTime())
    const fresh = await insertOrder(db)
    await confirmOrder(db, fresh)
    const claimed = (await db.query<{ id: number }>("select * from claim_arca_invoice(null)")).rows
    assert.equal(Number(claimed[0]?.id), fresh)
    assert.equal((await loadOrder(db, whileActive)).invoice_status, "pending")
    assert.equal((await loadOrder(db, whileOff)).invoice_status, "pending")
    const events = (await db.query<{ enabled: boolean }>("select enabled from arca_auto_invoicing_events order by id")).rows
    assert.deepEqual(events.map((event) => event.enabled), [true, false, true])
  } finally {
    await db.close()
  }
})

test("timeout automático reconcilia antes de reemitir y mantiene el pedido pagado", async () => {
  const db = await setupInvoicingDb()
  try {
    await applyAutoActivation(db)
    await firstManualProductionInvoice(db)
    await setAutomatic(db, true)
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    const arca = new FakeArca(POINT, "production")
    arca.vouchers.set(1, { total: 1000, cae: "CAE-MANUAL", caeDue: "20261130", date: argentinaDate(new Date()).arca })
    arca.next.push("lost_after_authorize")
    const client = rpcClient(db)
    const options = { gateway: arca, pointOfSale: POINT, now: () => new Date() }
    const first = await processArcaInvoiceQueue(client, { ...options, limit: 1 })
    assert.equal(first.failed, 1)
    const afterTimeout = await loadOrder(db, id)
    assert.equal(afterTimeout.financial_status, "payment_confirmed")
    assert.equal(afterTimeout.invoice_status, "error")
    assert.equal(Number(afterTimeout.invoice_requested_number), 2)
    await db.query("update ordenes set invoice_next_attempt_at=now() - interval '1 second' where id=$1", [id])
    const retry = await processArcaInvoice(client, options)
    assert.equal(retry.status, "authorized")
    assert.equal(retry.status === "authorized" && retry.invoice.reconciled, true)
    assert.equal(arca.requests, 1)
    assert.equal((await loadOrder(db, id)).financial_status, "payment_confirmed")
  } finally {
    await db.close()
  }
})
