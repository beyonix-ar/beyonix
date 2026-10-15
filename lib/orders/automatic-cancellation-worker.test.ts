import assert from "node:assert/strict"
import test from "node:test"
import type { PGlite } from "@electric-sql/pglite"

import type { CreditNoteArcaResult } from "../arca/credit-note-emission.ts"
import type { ArcaInvoiceGateway } from "../arca/invoice-automation.ts"
import type { MercadoPagoOrderReconciliationResult, MercadoPagoOrderRefundResult } from "../mercadopago/order-refund.ts"
import { AUTO_CANCELLATION_MAX_ATTEMPTS, runAutomaticCancellationBatch, type AutomaticCancellationDependencies } from "./automatic-cancellation.ts"
import { getAutomaticCancellationStatus } from "./automatic-cancellation-state.ts"
import { admin as adminId, customer, read, setupCombinedPaymentDb } from "./fixtures/combined-payment-db.ts"

// Worker de cancelaciones automáticas (NC C → reintegro) con las RPCs SQL
// REALES de claim/lease/release, reserva de NC (begin_partial_credit_note),
// restauración de saldo, reintegro MP del worker (begin_mercadopago_order_refund)
// y cierre sin dinero externo. ARCA y Mercado Pago son simulaciones: ninguna
// NC real, ningún POST real.

type Db = PGlite
type Behavior = "ok" | "down" | "lost" | "crash"

const RECOVERY_MIGRATION = "supabase/migrations/20261015190000_automatic_cancellation_recovery.sql"
const gateway = { environment: "production" } as ArcaInvoiceGateway
const parsers = { 1700: (value: string) => Number(value), 1184: (value: string) => value, 1082: (value: string) => value }

/** Cliente con la forma de supabase-js (.from/.rpc) sobre PGlite, sólo lo que usa el worker. */
function pgliteAdmin(db: Db) {
  type Filter = { sql: string; value: unknown }
  const toParam = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item !== "object")
    ? `{${value.join(",")}}`
    : value !== null && typeof value === "object" ? JSON.stringify(value) : value
  const run = async (sql: string, values: unknown[]) => {
    try {
      const { rows } = await db.query<Record<string, unknown>>(sql, values, { parsers })
      return { data: rows, error: null }
    } catch (cause) {
      return { data: null, error: { message: cause instanceof Error ? cause.message : String(cause) } }
    }
  }
  const from = (table: string) => {
    let columns = "*"
    let update: Record<string, unknown> | null = null
    const filters: Filter[] = []
    let orderBy = ""
    let limit = ""
    const execute = () => {
      const values: unknown[] = []
      const param = (value: unknown) => { values.push(toParam(value)); return `$${values.length}` }
      const sets = update ? Object.entries(update).map(([key, value]) => `"${key}" = ${param(value)}`).join(", ") : ""
      const where = filters.length ? ` where ${filters.map((filter) => filter.sql.replace("?", param(filter.value))).join(" and ")}` : ""
      return update
        ? run(`update ${table} set ${sets}${where} returning *`, values)
        : run(`select ${columns} from ${table}${where}${orderBy}${limit}`, values)
    }
    const chain = {
      select(list: string) {
        columns = list === "*" ? "*" : list.split(",").map((column) => column.trim()).filter((column) => !column.includes("("))
          .map((column) => `"${column}"`).join(",")
        return chain
      },
      update(patch: Record<string, unknown>) { update = patch; return chain },
      eq(column: string, value: unknown) { filters.push({ sql: `"${column}" = ?`, value }); return chain },
      in(column: string, list: unknown[]) { filters.push({ sql: `"${column}" = any(?)`, value: list }); return chain },
      order(column: string, options: { ascending?: boolean } = {}) {
        orderBy += `${orderBy ? "," : " order by"} "${column}" ${options.ascending === false ? "desc" : "asc"}`
        return chain
      },
      limit(count: number) { limit = ` limit ${Number(count)}`; return chain },
      async maybeSingle() { const result = await execute(); return { data: result.data?.[0] ?? null, error: result.error } },
      async single() { const result = await execute(); return { data: result.data?.[0] ?? null, error: result.error } },
      then<T>(resolve: (value: Awaited<ReturnType<typeof execute>>) => T, reject?: (cause: unknown) => T) {
        return execute().then(resolve, reject)
      },
    }
    return chain
  }
  const rpc = (name: string, args: Record<string, unknown>) => {
    const entries = Object.entries(args)
    const call = run(`select * from ${name}(${entries.map(([key], index) => `${key} => $${index + 1}`).join(", ")})`,
      entries.map(([, value]) => toParam(value)))
    return {
      then<T>(resolve: (value: Awaited<typeof call>) => T, reject?: (cause: unknown) => T) { return call.then(resolve, reject) },
      async maybeSingle() { const result = await call; return { data: result.data?.[0] ?? null, error: result.error } },
    }
  }
  return { from, rpc } as unknown as Parameters<typeof runAutomaticCancellationBatch>[0]
}

/** ARCA (NC C) y Mercado Pago simulados sobre la misma base. */
function simulatedServices(db: Db) {
  const arca = { requests: 0, last: 0, next: [] as Behavior[], issued: new Map<string, number>() }
  const finalizeFailures: Error[] = []
  const mp = { posts: [] as number[], next: [] as Array<"ok" | "lost">, refunds: new Map<string, number>() }
  const authorizeNote = async (noteId: string, number: number) => {
    await db.query(`update order_credit_notes set status='authorized', cae=$2, voucher_number=$3, authorized_at=now()
      where id=$1 and status<>'authorized'`, [noteId, `CAE-NC-${number}`, number])
  }
  const authorized = (number: number, resumed: boolean): CreditNoteArcaResult => ({
    status: "authorized", resumed,
    authorization: { environment: "production", pointOfSale: 1, voucherNumber: number, cae: `CAE-NC-${number}`,
      caeDue: "20261030", issueDate: "20261015", reconciled: resumed },
  })
  const confirmRefund = async (refundId: string, orderId: number, amount: number) => {
    await db.query("update mercadopago_order_refunds set status='confirmed', mp_refund_id=$2 where id=$1", [refundId, `MP-${refundId.slice(0, 8)}`])
    await db.query("update ordenes set financial_status='refunded', refund_amount=$2, refunded_at=now() where id=$1", [orderId, amount])
  }
  const deps: AutomaticCancellationDependencies = {
    async emitCreditNote(_admin, { noteId }) {
      const behavior = arca.next.shift() ?? "ok"
      if (behavior === "crash") throw new Error("WORKER_CRASHED_AFTER_RESERVATION")
      const note = (await db.query<{ status: string }>("select status from order_credit_notes where id=$1", [noteId])).rows[0]
      const known = arca.issued.get(noteId)
      if (note.status === "authorized") return authorized(known ?? 0, true)
      // ARCA caído: tampoco responde FECompConsultar.
      if (behavior === "down") return { status: "failed", outcome: "unknown", error: "WSFEv1 HTTP 503" }
      // Respuesta perdida en un intento anterior: FECompConsultar la encuentra.
      if (known !== undefined) { await authorizeNote(noteId, known); return authorized(known, true) }
      arca.requests += 1
      const number = ++arca.last
      arca.issued.set(noteId, number)
      if (behavior === "lost") return { status: "failed", outcome: "unknown", error: "timeout" }
      await authorizeNote(noteId, number)
      return authorized(number, false)
    },
    async finalizeCreditNote(_admin, { noteId }) {
      const failure = finalizeFailures.shift()
      if (failure) throw failure
      const note = (await db.query<{ order_id: number }>(
        "update order_credit_notes set finalized_at=coalesce(finalized_at, now()) where id=$1 and status='authorized' returning order_id", [noteId])).rows[0]
      assert.ok(note, "finaliza sólo una NC autorizada")
      await db.query("update ordenes set credit_note_required=false, credit_note_status='authorized' where id=$1", [note.order_id])
    },
    async refundMercadoPagoOrderPayment(_admin, { orderId, adminId }): Promise<MercadoPagoOrderRefundResult> {
      // Misma decisión que el código real: la toma la RPC begin_mercadopago_order_refund.
      const attempt = (await db.query<{ refund_id: string; amount: number; status: string; should_call_mp: boolean; idempotency_key: string }>(
        "select * from begin_mercadopago_order_refund($1::bigint, $2::uuid)", [orderId, adminId], { parsers })).rows[0]
      if (!attempt.should_call_mp) {
        return attempt.status === "confirmed" ? { kind: "already_confirmed" } : { kind: "in_progress", status: "processing" }
      }
      mp.posts.push(Number(attempt.amount))
      mp.refunds.set(attempt.idempotency_key, Number(attempt.amount))
      if ((mp.next.shift() ?? "ok") === "lost") {
        await db.query("update mercadopago_order_refunds set status='needs_reconciliation' where id=$1", [attempt.refund_id])
        return { kind: "unknown", reason: "MP_TIMEOUT" }
      }
      await confirmRefund(attempt.refund_id, orderId, Number(attempt.amount))
      return { kind: "confirmed", mpRefundId: `MP-${attempt.refund_id.slice(0, 8)}`, amount: Number(attempt.amount) }
    },
    async reconcileMercadoPagoOrderRefund(_admin, { orderId }): Promise<MercadoPagoOrderReconciliationResult> {
      // Sólo GET: nunca un POST nuevo.
      const pending = (await db.query<{ id: string; idempotency_key: string; amount: number }>(
        "select id, idempotency_key, amount from mercadopago_order_refunds where order_id=$1 and status='needs_reconciliation'", [orderId], { parsers })).rows[0]
      if (!pending) return { kind: "nothing_to_reconcile" }
      if (!mp.refunds.has(pending.idempotency_key)) return { kind: "not_found_yet" }
      await confirmRefund(pending.id, orderId, Number(pending.amount))
      return { kind: "confirmed", mpRefundId: `MP-${pending.id.slice(0, 8)}`, amount: Number(pending.amount) }
    },
  }
  return { arca, mp, deps, finalizeFailures }
}

async function setup({ recovery = true } = {}) {
  const db = await setupCombinedPaymentDb()
  await db.exec(`
    alter table ordenes add column if not exists shipping_cost_charged numeric default 0,
      add column if not exists invoice_created_at timestamptz, add column if not exists invoice_arca_environment text,
      add column if not exists invoice_requested_at timestamptz, add column if not exists refund_amount numeric,
      add column if not exists refunded_at timestamptz, add column if not exists credit_note_status text;
    alter table orden_items add column if not exists precio numeric, add column if not exists producto_id bigint,
      add column if not exists variante_id bigint, add column if not exists conditioned_name text;
    alter table order_credit_notes add column if not exists voucher_number integer, add column if not exists authorized_at timestamptz,
      add column if not exists reason_code text, add column if not exists resolution_type text,
      add column if not exists reception_status text, add column if not exists stock_destination text,
      add column if not exists original_shipping_paid numeric, add column if not exists original_shipping_refunded numeric;
  `)
  if (recovery) await db.exec(read(RECOVERY_MIGRATION))
  const services = simulatedServices(db)
  const admin = pgliteAdmin(db)
  const run = () => runAutomaticCancellationBatch(admin, gateway, 1, { deps: services.deps, deadlineMs: 20_000 })
  return { db, ...services, run }
}

type Sale = {
  id: number; external?: number; method?: "mercadopago" | "transferencia"
  paidAgo?: string; cancelledAgo?: string; invoiced?: boolean
}
/** Venta pagada de $100.000 (`external` cobrado afuera, el resto con saldo), facturada y cancelada por el cliente. */
async function cancelledSale(db: Db, { id, external = 100000, method = "mercadopago", paidAgo = "1 hour", cancelledAgo = "1 minute", invoiced = true }: Sale) {
  await db.query(`insert into ordenes(id,usuario_id,estado,total,original_total,payment_confirmed_amount,external_amount_due,
      credit_balance_used,financial_status,payment_method_id,payment_id,invoice_queued_at,invoice_status,invoice_cae,invoice_number,
      invoice_point,invoice_created_at,invoice_arca_environment,invoice_requested_at,credit_note_required,
      cancelled_at,cancellation_requested_at,refund_pending_at)
    values ($1,$2,'cancelado',100000,100000,$3,$3,$4,'refund_pending',$5,$12,now()-$6::interval,
      $7,$8,$9,1,case when $10 then now()-$6::interval end,'production',case when $10 then now()-$6::interval end,$10,
      now()-$11::interval,now()-$11::interval,now()-$11::interval)`,
    [id, customer, external, 100000 - external, method, paidAgo, invoiced ? "authorized" : "pending",
      invoiced ? `CAE-${id}` : null, invoiced ? id : null, invoiced, cancelledAgo, `PAY-${id}`])
  await db.query("insert into orden_items(id,orden_id,cantidad,precio,producto_id) values ($1,$2,1,100000,1)", [id * 10, id])
  await db.query(`insert into order_claims(order_id,user_id,claim_type,failure_type,description,status)
    values ($1,$2,'transporte_48hs','cancelar_compra','Me equivoqué de producto','reintegro_pendiente')`, [id, customer])
  if (100000 - external > 0) await db.query("select * from reverse_customer_credit_for_order($1,'Cancelación',$2)", [id, adminId])
}

const order = async (db: Db, id: number) => (await db.query<{
  financial_status: string; credit_note_required: boolean; auto_cancellation_attempts: number
  auto_cancellation_next_attempt_at: string; auto_cancellation_error: string | null; auto_cancellation_claimed_until: string | null
}>("select * from ordenes where id=$1", [id], { parsers })).rows[0]
const notes = async (db: Db, id: number) => (await db.query<{
  id: string; status: string; total_amount: number; external_amount: number; customer_credit_amount: number; finalized_at: string | null
}>("select * from order_credit_notes where order_id=$1 order by created_at", [id], { parsers })).rows
const restoredCredit = async (db: Db, id: number) => Number((await db.query<{ s: string }>(
  "select coalesce(sum(amount),0) s from customer_credit_movements where order_id=$1 and movement_type='reversal'", [id])).rows[0].s)
const expireRetry = (db: Db, id: number) =>
  db.query("update ordenes set auto_cancellation_next_attempt_at = now() - interval '1 second' where id=$1", [id])

async function assertClosedOnce(env: Awaited<ReturnType<typeof setup>>, id: number, external = 100000) {
  const final = await order(env.db, id)
  assert.equal(final.financial_status, "refunded", "pedido cerrado")
  assert.equal(final.credit_note_required, false)
  const authorizedNotes = (await notes(env.db, id)).filter((note) => note.status === "authorized")
  assert.equal(authorizedNotes.length, 1, "una sola NC")
  assert.ok(authorizedNotes[0].finalized_at)
  assert.equal(authorizedNotes[0].total_amount, 100000)
  assert.equal(authorizedNotes[0].external_amount, external)
}

test("A. compra hoy, facturada y cancelada → NC automática → refund MP → cerrado, sin intervención", async () => {
  const env = await setup()
  try {
    await cancelledSale(env.db, { id: 1 })
    const summary = await env.run()
    assert.deepEqual(summary, { checked: 1, completed: 1, pending: 0, manual: 0, errors: 0 })
    await assertClosedOnce(env, 1)
    assert.equal(env.arca.requests, 1)
    assert.deepEqual(env.mp.posts, [100000], "un único POST por la parte externa")
    assert.equal((await env.run()).checked, 0, "pedido cerrado: el worker no lo vuelve a tomar")
  } finally { await env.db.close() }
})

test("B. compra de ayer cancelada hoy, con el automático reactivado en el medio → igual se procesa", async () => {
  const before = await setup({ recovery: false })
  const after = await setup()
  try {
    for (const env of [before, after]) {
      await env.db.query("update arca_auto_invoicing_control set cutoff_at = now() - interval '12 hours'")
      await cancelledSale(env.db, { id: 2, paidAgo: "1 day 2 hours", cancelledAgo: "3 minutes" })
    }
    // Claim anterior (20261014140000): la factura encolada antes del corte lo excluía para siempre.
    assert.equal((await before.run()).checked, 0)
    assert.equal(before.arca.requests, 0)
    // 20261015190000: cuenta la cancelación, no la antigüedad de la compra.
    assert.equal((await after.run()).completed, 1)
    await assertClosedOnce(after, 2)
  } finally { await before.db.close(); await after.db.close() }
})

test("C. factura autorizada horas antes de cancelar → NC automática sobre esa factura", async () => {
  const env = await setup()
  try {
    await cancelledSale(env.db, { id: 3, paidAgo: "20 hours", cancelledAgo: "1 minute" })
    await env.run()
    await assertClosedOnce(env, 3)
    const note = (await env.db.query<{ invoice_number: number; invoice_point: number }>(
      "select invoice_number, invoice_point from order_credit_notes where order_id=3")).rows[0]
    assert.deepEqual([Number(note.invoice_point), Number(note.invoice_number)], [1, 3], "asociada a la Factura C del pedido")
  } finally { await env.db.close() }
})

test("D. cancelar antes de la factura → espera → llega el CAE → NC → refund", async () => {
  const env = await setup()
  try {
    await cancelledSale(env.db, { id: 4, invoiced: false })
    assert.equal((await env.run()).checked, 0, "sin Factura C no se toma (no hay NC posible)")
    assert.equal(env.arca.requests, 0)
    assert.deepEqual(env.mp.posts, [], "sin factura ni NC no se mueve dinero")
    // complete_arca_invoice con la venta ya cancelada: CAE + obligación de NC.
    await env.db.query(`update ordenes set invoice_status='authorized', invoice_cae='CAE-4', invoice_number=4, invoice_point=1,
      invoice_created_at=now(), invoice_requested_at=now(), credit_note_required=true where id=4`)
    assert.equal((await env.run()).completed, 1)
    await assertClosedOnce(env, 4)
  } finally { await env.db.close() }
})

test("E. el worker cae después de reservar la NC → reintento seguro: misma NC, un solo CAE, un solo refund", async () => {
  const env = await setup()
  try {
    await cancelledSale(env.db, { id: 5 })
    env.arca.next.push("crash")
    const first = await env.run()
    assert.equal(first.errors, 1)
    const stuck = await order(env.db, 5)
    assert.equal(stuck.auto_cancellation_claimed_until, null, "libera el lease")
    assert.notEqual(stuck.auto_cancellation_next_attempt_at, "infinity", "programa reintento, no lo abandona")
    assert.match(stuck.auto_cancellation_error ?? "", /WORKER_CRASHED_AFTER_RESERVATION/)
    assert.deepEqual((await notes(env.db, 5)).map((note) => note.status), ["processing"], "la reserva quedó")
    // ARCA respondió pero la respuesta se perdió; luego ARCA caído.
    await expireRetry(env.db, 5); env.arca.next.push("lost")
    assert.equal((await env.run()).pending, 1)
    await expireRetry(env.db, 5); env.arca.next.push("down")
    assert.equal((await env.run()).pending, 1)
    await expireRetry(env.db, 5)
    assert.equal((await env.run()).completed, 1)
    await assertClosedOnce(env, 5)
    assert.equal(env.arca.requests, 1, "la NC con respuesta perdida se concilia, no se vuelve a pedir")
    assert.deepEqual(env.mp.posts, [100000])
  } finally { await env.db.close() }
})

test("F. lease vencido (proceso muerto sin liberar) → vuelve a procesarse", async () => {
  const env = await setup()
  try {
    await cancelledSale(env.db, { id: 6 })
    // Un worker toma el pedido y muere: nunca llama a release_auto_cancellation.
    assert.equal((await env.db.query<{ id: number }>("select id from claim_auto_cancellation('5 minutes')")).rows[0].id, 6)
    assert.equal((await env.run()).checked, 0, "lease vigente: otro worker no lo toca")
    assert.equal((await env.db.query("select 1 from ordenes where id=6 and auto_cancellation_claimed_until > now()")).rows.length, 1)
    await env.db.query("update ordenes set auto_cancellation_claimed_until = now() - interval '1 second' where id=6")
    assert.equal((await env.run()).completed, 1)
    await assertClosedOnce(env, 6)
  } finally { await env.db.close() }
})

test("G. NC ya autorizada (el worker cae entre el CAE y la finalización) → no emite otra", async () => {
  const env = await setup()
  try {
    await cancelledSale(env.db, { id: 7 })
    env.finalizeFailures.push(new Error("WORKER_CRASHED_AFTER_CAE"))
    assert.equal((await env.run()).errors, 1)
    assert.deepEqual((await notes(env.db, 7)).map((note) => [note.status, note.finalized_at]), [["authorized", null]])
    assert.equal(env.arca.requests, 1)
    assert.deepEqual(env.mp.posts, [], "sin NC finalizada no hay refund")
    await expireRetry(env.db, 7)
    assert.equal((await env.run()).completed, 1)
    assert.equal(env.arca.requests, 1, "sin segundo FECAESolicitar")
    await assertClosedOnce(env, 7)
    assert.deepEqual(env.mp.posts, [100000])
  } finally { await env.db.close() }
})

test("H. refund ya confirmado (webhook/conciliación) → no repite el POST", async () => {
  const env = await setup()
  try {
    await cancelledSale(env.db, { id: 8 })
    env.mp.next.push("lost")
    assert.equal((await env.run()).pending, 1, "MP sin respuesta: queda en conciliación")
    assert.deepEqual(env.mp.posts, [100000])
    // La conciliación (GET) lo confirma antes del próximo intento del worker.
    await env.deps.reconcileMercadoPagoOrderRefund(pgliteAdmin(env.db) as never, { orderId: 8 })
    await env.db.query("update ordenes set financial_status='refund_pending' where id=8")
    await expireRetry(env.db, 8)
    assert.equal((await env.run()).completed, 1)
    assert.deepEqual(env.mp.posts, [100000], "begin_mercadopago_order_refund devuelve el intento confirmado: cero POST nuevos")
    assert.equal((await env.db.query<{ n: number }>("select count(*)::int n from mercadopago_order_refunds where order_id=8")).rows[0].n, 1)
  } finally { await env.db.close() }
})

test("I. transferencia → NC automática y se detiene: el dinero sale sólo con comprobante manual", async () => {
  const env = await setup()
  try {
    await cancelledSale(env.db, { id: 9, method: "transferencia" })
    assert.equal((await env.run()).manual, 1)
    const stopped = await order(env.db, 9)
    assert.equal(stopped.financial_status, "refund_pending", "sin comprobante no se marca reintegrado")
    assert.equal(stopped.auto_cancellation_next_attempt_at, "infinity")
    assert.equal(stopped.auto_cancellation_error, "BANK_TRANSFER_REFUND_REQUIRED")
    assert.deepEqual(env.mp.posts, [], "nunca Mercado Pago para una transferencia")
    assert.equal((await notes(env.db, 9)).filter((note) => note.status === "authorized" && note.finalized_at).length, 1)
    // Admin ve "Requiere acción", no un "procesando" eterno.
    const status = getAutomaticCancellationStatus({ ...stopped, estado: "cancelado", invoice_queued_at: new Date().toISOString() } as never,
      { enabled: true, cutoffAt: "2020-01-01T00:00:00Z" })
    assert.deepEqual(status, { state: "requires_action", reason: "manual", error: "BANK_TRANSFER_REFUND_REQUIRED" })
  } finally { await env.db.close() }
})

test("J. pago combinado $70.000 MP + $30.000 saldo → NC $100.000, POST $70.000, saldo $30.000 una vez", async () => {
  const env = await setup()
  try {
    await cancelledSale(env.db, { id: 10, external: 70000 })
    assert.equal(await restoredCredit(env.db, 10), 0, "antes de la NC no vuelve el saldo")
    assert.equal((await env.run()).completed, 1)
    const [note] = await notes(env.db, 10)
    assert.deepEqual([note.total_amount, note.external_amount, note.customer_credit_amount], [100000, 70000, 30000])
    assert.deepEqual(env.mp.posts, [70000])
    assert.equal(await restoredCredit(env.db, 10), 30000)
    await assertClosedOnce(env, 10, 70000)
    // Sólo saldo: NC y cierre sin dinero externo.
    await cancelledSale(env.db, { id: 11, external: 0, method: "transferencia" })
    assert.equal((await env.run()).completed, 1)
    assert.equal(await restoredCredit(env.db, 11), 100000)
    assert.equal((await order(env.db, 11)).financial_status, "refunded")
    assert.deepEqual(env.mp.posts, [70000], "sin POST para la parte de saldo")
  } finally { await env.db.close() }
})

test("K. dos workers a la vez → un solo claim, una sola NC, un solo refund", async () => {
  const env = await setup()
  try {
    for (const id of [12, 13, 14]) await cancelledSale(env.db, { id })
    const [first, second] = await Promise.all([env.run(), env.run()])
    assert.equal(first.checked + second.checked, 3, "cada pedido lo toma un solo worker")
    assert.equal(first.completed + second.completed, 3)
    for (const id of [12, 13, 14]) await assertClosedOnce(env, id)
    assert.equal(env.arca.requests, 3)
    assert.deepEqual(env.mp.posts, [100000, 100000, 100000])
  } finally { await env.db.close() }
})

test("L. BX-1005 (datos reales): elegible en SQL pero nunca tomado → Admin ve 'Requiere acción'; el timer de facturas lo cierra", async () => {
  const env = await setup()
  try {
    await env.db.query("update arca_auto_invoicing_control set cutoff_at='2026-10-14T03:24:06.029661Z'")
    await env.db.query(`insert into ordenes(id,usuario_id,estado,total,original_total,payment_confirmed_amount,external_amount_due,
        credit_balance_used,financial_status,payment_method_id,payment_id,payment_status,invoice_queued_at,invoice_status,invoice_cae,
        invoice_number,invoice_point,invoice_created_at,invoice_arca_environment,invoice_requested_at,credit_note_required,
        cancelled_at,cancellation_requested_at,refund_pending_at,shipping_cost_charged)
      values (5,$1,'cancelado',1000,1000,1000,1000,0,'refund_pending','mercadopago','184207719580','approved',
        '2026-10-14T23:05:25.134678Z','authorized','86417747630716',10,1,'2026-10-14T15:00:00Z','production',
        '2026-10-14T23:10:02.685117Z',true,'2026-10-15T16:01:15.531402Z','2026-10-15T16:01:15.531402Z','2026-10-15T16:01:15.531402Z',0)`, [customer])
    await env.db.query("insert into orden_items(id,orden_id,cantidad,precio,producto_id) values (5,5,1,1000,1)")
    await env.db.query(`insert into order_claims(order_id,user_id,claim_type,failure_type,description,status)
      values (5,$1,'transporte_48hs','cancelar_compra','Me equivoque de producto','reintegro_pendiente')`, [customer])
    const real = await order(env.db, 5)
    assert.equal(real.auto_cancellation_attempts, 0)
    assert.equal(real.auto_cancellation_next_attempt_at, "-infinity")
    // 12 minutos después de cancelar, sin worker: ya no "procesando".
    const control = { enabled: true, cutoffAt: "2026-10-14T03:24:06.029661Z" }
    const shape = {
      estado: "cancelado", financial_status: "refund_pending", invoice_status: "authorized",
      invoice_queued_at: "2026-10-14T23:05:25.134678Z", invoice_requested_at: "2026-10-14T23:10:02.685117Z",
      cancelled_at: "2026-10-15T16:01:15.531402Z", cancellation_requested_at: "2026-10-15T16:01:15.531402Z",
      refund_pending_at: "2026-10-15T16:01:15.531402Z", auto_cancellation_next_attempt_at: "-infinity",
      auto_cancellation_claimed_until: null, auto_cancellation_error: null,
    }
    assert.deepEqual(getAutomaticCancellationStatus(shape, control, Date.parse("2026-10-15T16:03:00Z")), { state: "processing" })
    assert.deepEqual(getAutomaticCancellationStatus(shape, control, Date.parse("2026-10-15T16:13:37Z")),
      { state: "requires_action", reason: "stalled", error: null })
    // La condición SQL nunca fue el bloqueo: el claim real lo toma apenas alguien lo llama.
    assert.deepEqual(await env.run(), { checked: 1, completed: 1, pending: 0, manual: 0, errors: 0 }, "lo que hace el timer de facturas después del deploy")
    const final = await order(env.db, 5)
    assert.equal(final.financial_status, "refunded")
    const [note] = await notes(env.db, 5)
    assert.deepEqual([note.status, note.total_amount, note.external_amount], ["authorized", 1000, 1000])
    assert.deepEqual(env.mp.posts, [1000])
    assert.equal(getAutomaticCancellationStatus({ ...shape, financial_status: "refunded" }, control), null)
  } finally { await env.db.close() }
})

test("M. sin 20261015190000 la NC del worker nunca se reservaba (CREDIT_NOTE_ACTOR_FORBIDDEN); el wrapper sigue cerrado al resto", async () => {
  const before = await setup({ recovery: false })
  const after = await setup()
  try {
    await cancelledSale(before.db, { id: 20 })
    assert.equal((await before.run()).errors, 1)
    const stuck = await order(before.db, 20)
    assert.equal(stuck.auto_cancellation_error, "CREDIT_NOTE_ACTOR_FORBIDDEN")
    assert.deepEqual(await notes(before.db, 20), [], "ninguna NC reservada")
    assert.equal(before.arca.requests, 0)

    await cancelledSale(after.db, { id: 21 })
    const reserve = (actor: string | null, operation = "cancelacion_antes_despacho") => after.db.query(
      `select id from begin_partial_credit_note(21::bigint,(select max(id) from order_claims where order_id=21),'external_refund','Cancelación',0,100000,100000,1,21::bigint,
        $1::uuid,'[]'::jsonb,$2,'{}'::uuid[])`, [actor, operation])
    await assert.rejects(reserve(null, "devolucion_parcial"), /CREDIT_NOTE_ACTOR_FORBIDDEN/, "NULL sólo para la cancelación del worker")
    await assert.rejects(reserve(customer), /CREDIT_NOTE_ACTOR_FORBIDDEN/, "un cliente nunca emite")
    const asRole = (role: string) => after.db.query("select set_config('request.jwt.claim.role', $1, false), set_config('request.jwt.claims', $2, false)", [role, JSON.stringify({ role })])
    await asRole("authenticated")
    await assert.rejects(reserve(null), /CREDIT_NOTE_ACTOR_FORBIDDEN/, "sólo service_role")
    await asRole("service_role")
    const note = (await reserve(null)).rows[0] as { id: string }
    await assert.rejects(reserve(null), /CREDIT_NOTE_SNAPSHOT_CONFLICT/, "el snapshot sigue protegiendo contra una segunda reserva")
    assert.ok(note.id)
  } finally { await before.db.close(); await after.db.close() }
})

test("N. un fallo que se repite agota los reintentos → 'Requiere acción' con el motivo, nunca 'procesando' eterno", async () => {
  const env = await setup()
  try {
    await cancelledSale(env.db, { id: 30 })
    await env.db.query("update ordenes set auto_cancellation_attempts=$2 where id=$1", [30, AUTO_CANCELLATION_MAX_ATTEMPTS - 2])
    env.arca.next.push("down", "down")
    assert.equal((await env.run()).pending, 1)
    const retrying = await order(env.db, 30)
    assert.notEqual(retrying.auto_cancellation_next_attempt_at, "infinity", "todavía con reintento programado")
    await expireRetry(env.db, 30)
    assert.equal((await env.run()).pending, 1)
    const exhausted = await order(env.db, 30)
    assert.equal(exhausted.auto_cancellation_next_attempt_at, "infinity")
    assert.equal(exhausted.auto_cancellation_error, "RETRIES_EXHAUSTED: ARCA_CREDIT_NOTE_RECONCILIATION")
    assert.equal(exhausted.financial_status, "refund_pending")
    assert.deepEqual(env.mp.posts, [], "sin NC autorizada nunca se mueve dinero")
    assert.equal(getAutomaticCancellationStatus({ ...exhausted, estado: "cancelado", invoice_queued_at: new Date().toISOString() } as never,
      { enabled: true, cutoffAt: "2020-01-01T00:00:00Z" })?.state, "requires_action")
  } finally { await env.db.close() }
})
