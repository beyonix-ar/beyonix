import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { processArcaInvoice, processArcaInvoiceQueue } from "./invoice-automation.ts"
import {
  FakeArca,
  applyAutoActivation,
  applyInvoiceObligation,
  confirmOrder,
  enableAutoInvoicing,
  insertOrder,
  loadOrder,
  rpcClient,
  setupInvoicingDb,
} from "./fixtures/arca-invoicing-db.ts"
import { ensureSaleInvoiced, hasPendingInvoiceObligation } from "../orders/fiscal-sequencing.ts"
import { getCreditNoteClaimPolicyError } from "../orders/credit-note-claim-policy.ts"

// La obligación de Factura C nace con el pago válido confirmado y una
// cancelación/reintegro posterior no la borra (20261014100000). Corre sobre
// las migraciones REALES de cola, worker, control automático y la corrección,
// con un ARCA simulado: nada se emite de verdad.

const POINT = 3
type Db = Awaited<ReturnType<typeof setupInvoicingDb>>

async function setup() {
  const db = await setupInvoicingDb()
  await applyAutoActivation(db)
  await applyInvoiceObligation(db)
  await enableAutoInvoicing(db, POINT)
  const arca = new FakeArca(POINT, "production")
  arca.vouchers.set(1, { total: 1000, cae: "CAE-MANUAL", caeDue: "20261130", date: "20261013" })
  const cron = () => processArcaInvoiceQueue(rpcClient(db), { gateway: arca, pointOfSale: POINT })
  return { db, arca, cron }
}

/** Misma escritura que admin_cancel_order (cancel con pago) + su auditoría. */
async function adminCancel(db: Db, id: number) {
  await db.query(`update ordenes set estado='cancelado', financial_status='refund_pending',
    cancelled_at=now(), cancellation_requested_at=now(), credit_note_required=false where id=$1`, [id])
  await db.query(`insert into order_audit_events (order_id, actor_type, action, new_status, metadata)
    values ($1,'admin','order_cancelled_refund_pending','refund_pending','{"source":"admin_direct_cancellation"}'::jsonb)`, [id])
}

const invoiceNumbers = (arca: FakeArca) => [...arca.vouchers.keys()].filter((number) => number > 1)

test("1. pago confirmado → el cron emite la Factura C normalmente", async () => {
  const { db, arca, cron } = await setup()
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    assert.equal((await cron()).authorized, 1)
    const order = await loadOrder(db, id)
    assert.equal(order.invoice_status, "authorized")
    assert.equal(order.credit_note_required, false, "venta vigente: no requiere NC")
    assert.deepEqual(invoiceNumbers(arca), [2])
  } finally { await db.close() }
})

test("2. pago confirmado → Admin cancela ANTES del cron → igual se emite la Factura C y queda exigida la NC", async () => {
  const { db, arca, cron } = await setup()
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    await adminCancel(db, id)
    const afterCancel = await loadOrder(db, id)
    assert.equal(afterCancel.invoice_status, "pending", "la cancelación no borra la obligación")
    assert.ok(afterCancel.invoice_next_attempt_at)

    assert.equal((await cron()).authorized, 1)
    const order = await loadOrder(db, id)
    assert.equal(order.invoice_status, "authorized")
    assert.equal(order.credit_note_required, true, "factura de una venta cancelada → NC C obligatoria")
    assert.equal(order.estado, "cancelado")
    assert.deepEqual(invoiceNumbers(arca), [2])
    // La NC de una cancelación directa de Admin se autoriza con su auditoría.
    assert.equal((await db.query<{ ok: boolean }>("select order_has_admin_direct_cancellation($1) ok", [id])).rows[0].ok, true)
  } finally { await db.close() }
})

test("3. cancelar SIN pago → no hay factura ni NC", async () => {
  const { db, arca, cron } = await setup()
  try {
    const id = await insertOrder(db)
    await db.query("update ordenes set estado='cancelado', financial_status='cancelled', cancelled_at=now() where id=$1", [id])
    const order = await loadOrder(db, id)
    assert.equal(order.invoice_status, null)
    assert.equal(order.invoice_queued_at, null)
    assert.equal((await cron()).results.length, 0)
    assert.equal((await loadOrder(db, id)).credit_note_required, false)
    assert.equal(arca.requests, 0)
    assert.equal(hasPendingInvoiceObligation(await loadOrder(db, id) as never), false)
  } finally { await db.close() }
})

test("4. factura y cancelación concurrentes (cancelación con la factura en curso) → 1 factura + NC exigida", async () => {
  const { db, arca } = await setup()
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    const client = rpcClient(db)
    // El worker toma el pedido y, mientras ARCA responde, Admin cancela.
    arca.beforeRequest = async () => { await adminCancel(db, id) }
    const result = await processArcaInvoice(client, { gateway: arca, pointOfSale: POINT })
    assert.equal(result.status, "authorized")
    const order = await loadOrder(db, id)
    assert.equal(order.estado, "cancelado")
    assert.equal(order.invoice_status, "authorized")
    assert.equal(order.credit_note_required, true)
    // Otra corrida (o un Admin) no emite una segunda factura.
    assert.equal((await processArcaInvoiceQueue(client, { gateway: arca, pointOfSale: POINT })).results.length, 0)
    assert.deepEqual(await processArcaInvoice(client, { gateway: arca, pointOfSale: POINT, orderId: id, manual: true }), { status: "already_authorized" })
    assert.deepEqual(invoiceNumbers(arca), [2])
  } finally { await db.close() }
})

test("5. webhooks repetidos (antes y después de cancelar) → una sola cola, una sola factura", async () => {
  const { db, arca, cron } = await setup()
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    const queuedAt = String((await loadOrder(db, id)).invoice_queued_at)
    await confirmOrder(db, id)
    await adminCancel(db, id)
    await db.query("update ordenes set payment_status='refunded' where id=$1", [id])
    await db.query("update ordenes set payment_status='refunded' where id=$1", [id])
    assert.equal(String((await loadOrder(db, id)).invoice_queued_at), queuedAt, "la obligación conserva su fecha de origen")
    assert.equal((await cron()).authorized, 1)
    assert.equal((await cron()).results.length, 0)
    assert.deepEqual(invoiceNumbers(arca), [2])
  } finally { await db.close() }
})

test("6. error de ARCA sobre una venta cancelada → conserva la obligación y reintenta sin duplicar", async () => {
  const { db, arca, cron } = await setup()
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    await adminCancel(db, id)
    arca.down = true
    assert.equal((await cron()).failed, 1)
    const failed = await loadOrder(db, id)
    assert.equal(failed.invoice_status, "error", "antes, fail_arca_invoice_attempt lo sacaba de la cola")
    assert.ok(failed.invoice_next_attempt_at, "reintento programado")
    arca.down = false
    await db.query("update ordenes set invoice_next_attempt_at = now() - interval '1 second' where id=$1", [id])
    assert.equal((await cron()).authorized, 1)
    assert.equal((await loadOrder(db, id)).credit_note_required, true)
    assert.deepEqual(invoiceNumbers(arca), [2])
  } finally { await db.close() }
})

test("7. reintegro completado con la factura todavía pendiente → la obligación fiscal sigue y termina en Factura C + NC exigida", async () => {
  const { db, arca, cron } = await setup()
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    await adminCancel(db, id)
    // Reintegro ya hecho (MP confirmó y su webhook marcó el pago como reintegrado).
    await db.query("update ordenes set financial_status='refunded', payment_status='refunded' where id=$1", [id])
    assert.equal((await loadOrder(db, id)).invoice_status, "pending")
    assert.equal(hasPendingInvoiceObligation(await loadOrder(db, id) as never), true)
    assert.equal((await cron()).authorized, 1)
    const order = await loadOrder(db, id)
    assert.equal(order.invoice_status, "authorized")
    assert.equal(order.credit_note_required, true)
    assert.deepEqual(invoiceNumbers(arca), [2])
  } finally { await db.close() }
})

test("regresión: un cambio de pedido en curso sigue pausando la cola; una venta ya desencolada antes no se reencola sola", async () => {
  const { db, cron } = await setup()
  try {
    const id = await insertOrder(db)
    await confirmOrder(db, id)
    await db.query("update ordenes set order_change_status='change_requested' where id=$1", [id])
    assert.equal((await loadOrder(db, id)).invoice_status, null, "cambio en curso: pausa como antes")
    await db.query("update ordenes set order_change_status=null where id=$1", [id])
    assert.equal((await loadOrder(db, id)).invoice_status, "pending", "al terminar el cambio vuelve a la cola")

    // Caso BX-1002: desencolado por la regla anterior (invoice_status null).
    const legacy = await insertOrder(db)
    await confirmOrder(db, legacy)
    await db.query("alter table ordenes disable trigger zz_queue_arca_invoice")
    await db.query("update ordenes set estado='cancelado', financial_status='refunded', invoice_status=null, invoice_next_attempt_at=null where id=$1", [legacy])
    await db.query("alter table ordenes enable trigger zz_queue_arca_invoice")
    await db.query("update ordenes set payment_status='refunded' where id=$1", [legacy])
    assert.equal((await loadOrder(db, legacy)).invoice_status, null, "no se reencola por cualquier UPDATE")
    const run = await cron()
    assert.ok(run.results.every((result) => result.status !== "authorized" || result.invoice.orderId !== legacy))
  } finally { await db.close() }
})

test("resolución financiera: la Factura C va antes que la NC y que mover dinero; espera si la numeración está ocupada", async () => {
  const calls: string[] = []
  const busyThenOk = [{ status: "busy" as const }, { status: "authorized" as const, invoice: {} as never }]
  assert.deepEqual(await ensureSaleInvoiced(async () => { calls.push("issue"); return busyThenOk.shift()! }, { waitMs: 1 }), { ok: true })
  assert.deepEqual(calls, ["issue", "issue"])
  assert.deepEqual(await ensureSaleInvoiced(async () => ({ status: "already_authorized" })), { ok: true })
  const failed = await ensureSaleInvoiced(async () => ({ status: "failed", orderId: 1, error: "HTTP 503", willRetry: true }))
  assert.equal(failed.ok, false)
  assert.match(failed.ok ? "" : failed.error, /Factura C de esta venta está pendiente: HTTP 503/)
  const stuck = await ensureSaleInvoiced(async () => ({ status: "busy" }), { attempts: 2, waitMs: 1 })
  assert.equal(stuck.ok, false)

  const source = readFileSync("lib/orders/financial-resolution-server.ts", "utf8")
  const body = source.slice(source.indexOf("export async function executeFinancialResolution"))
  const invoiceIndex = body.indexOf("if (hasPendingInvoiceObligation(fresh.order))")
  const noteIndex = body.indexOf("await ensureCreditNote(admin, fresh, claimed, actorId, authorization)")
  const refundIndex = body.indexOf("refundMercadoPagoOrderPayment(admin")
  const creditIndex = body.indexOf("createCustomerCreditMovement(admin")
  const manualIndex = body.indexOf('updateResolution(admin, claimed, "manual_pending"')
  assert.ok(invoiceIndex > 0 && invoiceIndex < noteIndex, "factura antes que la NC")
  assert.ok(noteIndex < refundIndex && noteIndex < creditIndex && noteIndex < manualIndex, "NC antes que el dinero")
  assert.match(body.slice(invoiceIndex, noteIndex), /if \(!invoiced\.ok\) fail\(invoiced\.error\)/, "sin factura no avanza")
})

test("política de la app = política de la base: NC de cancelación sin reclamo sólo con cancelación directa de Admin", () => {
  const base = { actorRole: "admin", orderId: 1, orderUserId: "c", claim: null, selectedItems: [{ order_item_id: 1, quantity: 1 }] }
  assert.equal(getCreditNoteClaimPolicyError({ ...base, operationType: "cancelacion_antes_despacho", adminDirectCancellation: true }), null)
  assert.match(getCreditNoteClaimPolicyError({ ...base, operationType: "cancelacion_antes_despacho" }) ?? "", /requiere un reclamo/)
  assert.match(getCreditNoteClaimPolicyError({ ...base, operationType: "devolucion_parcial", adminDirectCancellation: true }) ?? "", /requiere un reclamo/)
  const route = readFileSync("app/api/admin/orders/[id]/credit-note/route.ts", "utf8")
  assert.match(route, /rpc\("order_has_admin_direct_cancellation", \{ p_order_id: orderId \}\)/)
  assert.match(route, /adminDirectCancellation: adminDirectCancellation === true/)
})

test("NC de una cancelación directa de Admin: sin reclamo sólo con su auditoría; topes intactos", async () => {
  const migration = readFileSync("supabase/migrations/20261014100000_invoice_obligation_survives_cancellation.sql", "utf8").replace(/\r\n/g, "\n")
  const block = (start: string) => {
    const from = migration.indexOf(start)
    return migration.slice(from, migration.indexOf("$$;", migration.indexOf("as $$", from)) + 3)
  }
  const db = new PGlite()
  try {
    await db.exec(readFileSync("lib/orders/fixtures/claim-schema.sql", "utf8"))
    for (const path of [
      "supabase/migrations/20260816120000_atomic_order_claim_cancellation.sql",
      "supabase/migrations/20260905150000_claims_atomic_operations.sql",
      "supabase/migrations/20260906090000_claim_case_type_transitions.sql",
      "supabase/migrations/20260906100000_claims_final_security.sql",
      "supabase/migrations/20260906110000_claim_credit_note_snapshot.sql",
      "supabase/migrations/20260917120000_credit_note_refundable_external_cap.sql",
    ]) await db.exec(readFileSync(path, "utf8"))
    await db.exec(block("create or replace function public.order_has_admin_direct_cancellation("))
    await db.exec(block("create or replace function public.begin_partial_credit_note("))
    await db.query("select set_config('request.jwt.claim.role','service_role',false)")
    const admin = "10000000-0000-4000-8000-000000000003"
    const customer = "10000000-0000-4000-8000-000000000001"
    await db.query("insert into auth.users values($1,'a@example.test',now()),($2,'c@example.test',now())", [admin, customer])
    await db.query("insert into profiles(id,email,rol) values($1,'a@example.test','admin'),($2,'c@example.test','cliente')", [admin, customer])
    for (const id of [1, 2]) {
      await db.query(`insert into ordenes(id,usuario_id,estado,total,invoice_status,invoice_cae,invoice_number,invoice_point,
        payment_confirmed_amount,external_amount_due,financial_status) values ($1,$2,'cancelado',1000,'authorized','CAE',$3,1,1000,1000,'refund_pending')`, [id, customer, id])
    }
    await db.query(`insert into order_audit_events(order_id,actor_type,action,metadata)
      values (1,'admin','order_cancelled_refund_pending','{"source":"admin_direct_cancellation"}'::jsonb)`)
    const reserve = (orderId: number, amount: number) => db.query(
      "select id from begin_partial_credit_note($1::bigint,null,'external_refund','Cancelación aprobada',0,$2::numeric,$2::numeric,1,$1::bigint,$3::uuid,'[]','cancelacion_antes_despacho')",
      [orderId, amount, admin],
    )
    // Pedido 1: cancelado por Admin → la NC de cancelación se reserva sin reclamo.
    const note = await reserve(1, 1000)
    assert.ok(note.rows[0])
    // Pedido 2: sin auditoría de Admin (y sin reclamo) → sigue exigiendo reclamo.
    await assert.rejects(reserve(2, 1000), /CLAIM_REQUIRED/)
    // Nunca dos NC por la misma venta: una en curso bloquea y el total no puede superar la factura.
    await assert.rejects(reserve(1, 1000), /CREDIT_NOTE_PROCESSING_IN_PROGRESS/)
    await db.query("update order_credit_notes set status='authorized' where order_id=1")
    await assert.rejects(reserve(1, 1), /CREDIT_NOTE_EXCEEDS_INVOICE|CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT/)
    // Otra operación sin reclamo sigue prohibida aunque el pedido tenga la auditoría.
    await assert.rejects(db.query(
      "select id from begin_partial_credit_note(1,null,'external_refund','Devolución',0,1,1,1,1,$1,'[]','devolucion_parcial')", [admin],
    ), /CLAIM_REQUIRED/)
  } finally { await db.close() }
})
