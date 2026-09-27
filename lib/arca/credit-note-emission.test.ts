import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { emitCreditNote, reconcileCreditNote } from "./credit-note-emission.ts"
import { FakeArca } from "./fixtures/arca-invoicing-db.ts"
import type { FecaeRequest } from "./wsfe.ts"

// Nota de Crédito C contra la migración REAL 20260927110000 (PGlite) y un
// ARCA simulado con numeración secuencial: nunca dos NC por una emisión.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")
const POINT = 3
const INVOICE = { environment: "homologation" as const, pointOfSale: POINT, voucherNumber: 57, voucherDate: "20260920" }
const ASSOCIATED = { voucherType: 11, pointOfSale: POINT, voucherNumber: 57 }
const now = () => new Date("2026-09-27T15:00:00-03:00")

async function setup(invoiceEnvironment = "homologation") {
  const db = new PGlite()
  await db.exec(read("lib/arca/fixtures/arca-credit-note-schema.sql"))
  await db.exec(read("supabase/migrations/20260927110000_arca_credit_note_hardening.sql"))
  await db.exec(read("supabase/migrations/20260927120000_arca_environment_isolation.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  // Pedido con su Factura C 3-57 autorizada en el ambiente indicado.
  await db.query(
    `insert into ordenes (id, invoice_status, invoice_point, invoice_number, invoice_cae, invoice_arca_environment)
     values (1, 'authorized', $1, $2, 'CAE-F57', $3)`,
    [POINT, INVOICE.voucherNumber, invoiceEnvironment],
  )
  return db
}

/** Reserva como la deja begin_partial_credit_note ('processing'). */
async function reserveNote(db: PGlite, total = 300, destination = "external_refund") {
  const { rows } = await db.query<{ id: string }>(
    `insert into order_credit_notes (order_id, total_amount, items_amount, invoice_point, invoice_number, destination)
     values (1, $1, $1, $2, $3, $4) returning id`,
    [total, INVOICE.pointOfSale, INVOICE.voucherNumber, destination],
  )
  return rows[0].id
}

const note = async (db: PGlite, id: string) =>
  (await db.query<Record<string, unknown>>("select * from order_credit_notes where id=$1", [id])).rows[0]

function rpcClient(db: PGlite, hooks: { beforeRpc?: (name: string) => void } = {}) {
  const signatures: Record<string, string[]> = {
    claim_credit_note_arca: ["p_note_id::uuid", "p_lease::interval"],
    record_credit_note_request: ["p_note_id::uuid", "p_point::integer", "p_number::bigint", "p_total::numeric", "p_date::text", "p_environment::text"],
    complete_credit_note_authorization: ["p_note_id::uuid", "p_point::integer", "p_number::bigint", "p_cae::text", "p_cae_due::date", "p_authorized_at::timestamptz", "p_reconciled::boolean", "p_environment::text"],
    fail_credit_note_arca_attempt: ["p_note_id::uuid", "p_error::text", "p_outcome::text"],
  }
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      hooks.beforeRpc?.(name)
      const params = signatures[name]
      assert.ok(params, name)
      const values = params.map((param) => args[param.split("::")[0]] ?? null)
      try {
        const { rows } = await db.query(
          `select * from ${name}(${params.map((param, index) => `$${index + 1}::${param.split("::")[1]}`).join(", ")})`,
          values,
        )
        return { data: rows, error: null }
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error) } }
      }
    },
  }
}

function recordingArca() {
  const arca = new FakeArca(POINT)
  const requests: FecaeRequest[] = []
  const original = arca.requestCae.bind(arca)
  arca.requestCae = async (request) => {
    requests.push(request)
    return original(request)
  }
  return { arca, requests }
}

const emit = (db: PGlite, arca: FakeArca, noteId: string, client = rpcClient(db)) =>
  emitCreditNote(client, { noteId, gateway: arca, pointOfSale: POINT, associatedInvoice: INVOICE, now })

test("1. NC normal: CAE, relación Factura -> NC en CbtesAsoc y en la nota", async () => {
  const db = await setup()
  const { arca, requests } = recordingArca()
  try {
    const id = await reserveNote(db, 300)
    const result = await emit(db, arca, id)
    assert.equal(result.status, "authorized")
    const row = await note(db, id)
    assert.equal(row.status, "authorized")
    assert.equal(Number(row.voucher_number), 1)
    assert.equal(Number(row.voucher_point), POINT)
    assert.ok(row.cae && row.cae_due && row.authorized_at)
    assert.equal(row.finalized_at, null, "los pasos posteriores todavía no corrieron")
    assert.deepEqual([Number(row.invoice_point), Number(row.invoice_number)], [POINT, 57])
    assert.equal(requests.length, 1)
    assert.equal(requests[0].voucherType, 13)
    assert.equal(requests[0].total, 300)
    assert.deepEqual(requests[0].associatedVoucher, { voucherType: 11, pointOfSale: POINT, voucherNumber: 57, voucherDate: "20260920" })
    const audit = (await db.query<{ n: number }>(
      "select count(*)::int as n from order_audit_events where action='credit_note_arca_authorized'")).rows[0].n
    assert.equal(audit, 1)
  } finally {
    await db.close()
  }
})

test("2. doble click: la misma NC dos veces a la vez -> una sola solicitud a ARCA; una segunda reserva no entra", async () => {
  const db = await setup()
  const { arca } = recordingArca()
  try {
    const id = await reserveNote(db, 300)
    const [first, second] = await Promise.all([emit(db, arca, id), emit(db, arca, id)])
    const statuses = [first.status, second.status].sort()
    assert.deepEqual(statuses, ["authorized", "busy"])
    assert.equal(arca.requests, 1)
    assert.equal(arca.vouchers.size, 1)
    // Otra emisión mientras ésta sigue 'processing' no se puede reservar
    // (índice real order_credit_notes_single_processing).
    const other = await reserveNote(db, 200).catch((error: Error) => error)
    assert.ok(other instanceof Error || typeof other === "string")
    // Mientras la emisión original completa sus pasos posteriores conserva el
    // lease: un tercer click también queda afuera.
    assert.deepEqual(await emit(db, arca, id), { status: "busy" })
    // Liberado el lease (terminó o venció), repetir no pide otro CAE: reanuda.
    await db.query("update order_credit_notes set arca_claimed_until = now() - interval '1 second' where id=$1", [id])
    const again = await emit(db, arca, id)
    assert.equal(again.status, "authorized")
    assert.equal(again.status === "authorized" && again.resumed, true)
    assert.equal(arca.requests, 1)
  } finally {
    await db.close()
  }
})

test("4. ARCA autoriza y la respuesta se pierde -> el reintento concilia y adopta; nunca otra NC", async () => {
  const db = await setup()
  const { arca } = recordingArca()
  try {
    const id = await reserveNote(db, 300)
    arca.next.push("lost_after_authorize")
    const lost = await emit(db, arca, id)
    assert.equal(lost.status, "failed")
    assert.equal(lost.status === "failed" && lost.outcome, "unknown")
    const pending = await note(db, id)
    assert.equal(pending.status, "processing", "fail-closed: sigue reservada")
    assert.equal(Number(pending.voucher_number), 1)
    assert.match(String(pending.error), /pendiente de conciliación/)

    const retried = await emit(db, arca, id)
    assert.equal(retried.status, "authorized")
    assert.equal(retried.status === "authorized" && retried.authorization.reconciled, true)
    assert.equal(arca.requests, 1, "nunca se volvió a pedir CAE")
    assert.equal(arca.vouchers.size, 1)
    assert.equal((await note(db, id)).cae, arca.vouchers.get(1)?.cae)
  } finally {
    await db.close()
  }
})

test("5. reinicio después de autorizar (falló guardar) -> el lease bloquea hasta vencer; luego concilia", async () => {
  const db = await setup()
  const { arca } = recordingArca()
  try {
    const id = await reserveNote(db, 300)
    const crashing = rpcClient(db, {
      beforeRpc(name) {
        if (name === "complete_credit_note_authorization" || name === "fail_credit_note_arca_attempt") {
          throw new Error("connection terminated")
        }
      },
    })
    const crashed = await emit(db, arca, id, crashing).catch((error: Error) => error)
    assert.ok(crashed)
    const stuck = await note(db, id)
    assert.equal(stuck.status, "processing")
    assert.ok(stuck.arca_claimed_until, "lease tomado por el proceso que murió")

    const client = rpcClient(db)
    assert.deepEqual(await reconcileCreditNote(client, { noteId: id, gateway: arca }), { status: "busy" })
    await db.query("update order_credit_notes set arca_claimed_until = now() - interval '1 second' where id=$1", [id])
    const reconciled = await reconcileCreditNote(client, { noteId: id, gateway: arca })
    assert.equal(reconciled.status, "authorized")
    assert.equal(arca.requests, 1)
    assert.equal(arca.vouchers.size, 1)
  } finally {
    await db.close()
  }
})

test("6. número ya autorizado con el mismo importe (NC colgada de la versión anterior) -> se adopta", async () => {
  const db = await setup()
  const { arca } = recordingArca()
  try {
    const id = await reserveNote(db, 450)
    // Versión anterior de la ruta: guardaba voucher_* sin importe pedido.
    await db.query("update order_credit_notes set arca_environment='homologation', voucher_point=$2, voucher_number=4 where id=$1", [id, POINT])
    for (const n of [1, 2, 3]) arca.vouchers.set(n, { total: 10, cae: `C${n}`, caeDue: "20261010", date: "20260920" })
    arca.vouchers.set(4, { total: 450, cae: "CAE-4", caeDue: "20261010", date: "20260926", associated: [ASSOCIATED] })
    const result = await reconcileCreditNote(rpcClient(db), { noteId: id, gateway: arca })
    assert.equal(result.status, "authorized")
    const row = (await db.query<{ cae: string; cae_due: string }>(
      "select cae, cae_due::text from order_credit_notes where id=$1", [id])).rows[0]
    assert.equal(row.cae, "CAE-4")
    assert.equal(row.cae_due, "2026-10-10")
    assert.equal(arca.requests, 0, "no se pidió ningún CAE")
  } finally {
    await db.close()
  }
})

test("7. número autorizado con OTRO importe -> revisión manual, sin adoptar ni re-emitir", async () => {
  const db = await setup()
  const { arca } = recordingArca()
  try {
    const id = await reserveNote(db, 300)
    await db.query("update order_credit_notes set arca_environment='homologation', voucher_point=$2, voucher_number=1, requested_total=300 where id=$1", [id, POINT])
    arca.vouchers.set(1, { total: 999, cae: "AJENO", caeDue: "20261010", date: "20260926" })
    const result = await emit(db, arca, id)
    assert.equal(result.status, "failed")
    assert.equal(result.status === "failed" && result.outcome, "manual_review")
    const row = await note(db, id)
    assert.equal(row.status, "processing")
    assert.equal(row.cae, null)
    assert.match(String(row.error), /Revisión manual/)
    assert.equal(arca.requests, 0)
    // Reintentar sigue en revisión manual: jamás adopta ni pide otro número.
    assert.equal((await emit(db, arca, id)).status, "failed")
    assert.equal(arca.requests, 0)
  } finally {
    await db.close()
  }
})

test("7b. mismo número e importe pero otra factura asociada, sin CbtesAsoc u otra fecha -> revisión manual", async () => {
  const cases = [
    { label: "otra factura", voucher: { associated: [{ ...ASSOCIATED, voucherNumber: 58 }] } },
    { label: "otro punto", voucher: { associated: [{ ...ASSOCIATED, pointOfSale: POINT + 1 }] } },
    { label: "sin CbtesAsoc", voucher: { associated: [] } },
    { label: "dos asociados", voucher: { associated: [ASSOCIATED, { ...ASSOCIATED, voucherNumber: 58 }] } },
    { label: "otra fecha", voucher: { associated: [ASSOCIATED], date: "20260926" } },
  ]
  for (const { label, voucher } of cases) {
    const db = await setup()
    const { arca } = recordingArca()
    try {
      const id = await reserveNote(db, 300)
      await db.query(
        "update order_credit_notes set arca_environment='homologation', voucher_point=$2, voucher_number=1, requested_total=300, requested_date='20260927' where id=$1",
        [id, POINT],
      )
      arca.vouchers.set(1, { total: 300, cae: "AJENO", caeDue: "20261010", date: "20260927", ...voucher })
      const result = await reconcileCreditNote(rpcClient(db), { noteId: id, gateway: arca })
      assert.equal(result.status === "failed" && result.outcome, "manual_review", label)
      const row = await note(db, id)
      assert.equal(row.cae, null, label)
      assert.equal(row.status, "processing", label)
      assert.equal(arca.requests, 0, label)
    } finally {
      await db.close()
    }
  }
})

test("ARCA confirma que no lo autorizó / rechazo definitivo -> se libera (y la reserva de importes)", async () => {
  const db = await setup()
  const { arca } = recordingArca()
  try {
    const id = await reserveNote(db, 300)
    arca.next.push("reject")
    const rejected = await emit(db, arca, id)
    assert.equal(rejected.status === "failed" && rejected.outcome, "rejected")
    const row = await note(db, id)
    assert.equal(row.status, "error")
    assert.equal(row.voucher_number, null)
    assert.equal((await db.query<{ credit_note_status: string }>("select credit_note_status from ordenes where id=1")).rows[0].credit_note_status, "error")

    // Colgada con un número que ARCA nunca autorizó: la conciliación la libera.
    const stuck = await reserveNote(db, 200)
    await db.query("update order_credit_notes set arca_environment='homologation', voucher_point=$2, voucher_number=1, requested_total=200 where id=$1", [stuck, POINT])
    const released = await reconcileCreditNote(rpcClient(db), { noteId: stuck, gateway: arca })
    assert.equal(released.status, "released")
    assert.equal((await note(db, stuck)).status, "error")
    assert.equal(arca.requests, 1, "la conciliación nunca pide CAE")

    // Cortada antes de pedir número: también se libera.
    const early = await reserveNote(db, 100)
    assert.equal((await reconcileCreditNote(rpcClient(db), { noteId: early, gateway: arca })).status, "released")
  } finally {
    await db.close()
  }
})

test("8. NC parciales sucesivas sobre la misma factura: números propios, importe exacto y misma factura asociada", async () => {
  const db = await setup()
  const { arca, requests } = recordingArca()
  try {
    const first = await reserveNote(db, 300)
    assert.equal((await emit(db, arca, first)).status, "authorized")
    const second = await reserveNote(db, 200, "customer_balance")
    assert.equal((await emit(db, arca, second)).status, "authorized")
    assert.deepEqual(requests.map((request) => [request.voucherNumber, request.total]), [[1, 300], [2, 200]])
    assert.ok(requests.every((request) => request.associatedVoucher?.voucherNumber === 57))
    const balance = await note(db, second)
    assert.equal(balance.management_status, "nota_credito_emitida")
    assert.equal(balance.settlement_status, "procesando")

    // El importe pedido a ARCA tiene que ser exactamente el de la NC.
    const third = await reserveNote(db, 150)
    await db.query("select * from claim_credit_note_arca($1)", [third])
    await assert.rejects(
      db.query("select * from record_credit_note_request($1, 3, 3, 149.99, '20260927', 'homologation')", [third]),
      /CREDIT_NOTE_AMOUNT_MISMATCH/,
    )
    // Número ya usado por otra NC: rechazado por el índice real.
    await assert.rejects(
      db.query("select * from record_credit_note_request($1, 3, 1, 150, '20260927', 'homologation')", [third]),
      /CREDIT_NOTE_NUMBER_ALREADY_USED/,
    )
  } finally {
    await db.close()
  }
})

test("CAE idempotente y finalización una sola vez", async () => {
  const db = await setup()
  const { arca } = recordingArca()
  try {
    const id = await reserveNote(db, 300)
    await emit(db, arca, id)
    const row = await note(db, id)
    const complete = (cae: unknown) => db.query(
      "select * from complete_credit_note_authorization($1::uuid, $2::integer, $3::bigint, $4::text, $5::date, now(), false, 'homologation')",
      [id, POINT, 1, cae, "2026-10-10"],
    )
    await complete(row.cae)
    await assert.rejects(complete("OTRO"), /CREDIT_NOTE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER/)
    assert.equal((await db.query<{ first: boolean }>("select finish_credit_note_finalization($1) as first", [id])).rows[0].first, true)
    assert.equal((await db.query<{ first: boolean }>("select finish_credit_note_finalization($1) as first", [id])).rows[0].first, false)
    await assert.rejects(db.query("select * from claim_credit_note_arca($1)", [id]), /CREDIT_NOTE_ALREADY_FINALIZED/)
  } finally {
    await db.close()
  }
})

test("9. seguridad: todo sólo service_role; sin rol se niega", async () => {
  const db = await setup()
  try {
    const { rows } = await db.query<Record<string, boolean>>(`
      select
        has_function_privilege('anon', 'public.claim_credit_note_arca(uuid, interval)', 'EXECUTE') as anon_claim,
        has_function_privilege('authenticated', 'public.claim_credit_note_arca(uuid, interval)', 'EXECUTE') as auth_claim,
        has_function_privilege('authenticated', 'public.record_credit_note_request(uuid, integer, bigint, numeric, text, text)', 'EXECUTE') as auth_record,
        has_function_privilege('authenticated', 'public.complete_credit_note_authorization(uuid, integer, bigint, text, date, timestamptz, boolean, text)', 'EXECUTE') as auth_complete,
        has_function_privilege('authenticated', 'public.fail_credit_note_arca_attempt(uuid, text, text)', 'EXECUTE') as auth_fail,
        has_function_privilege('authenticated', 'public.finish_credit_note_finalization(uuid)', 'EXECUTE') as auth_finish,
        has_function_privilege('service_role', 'public.claim_credit_note_arca(uuid, interval)', 'EXECUTE') as service_claim
    `)
    assert.deepEqual(rows[0], {
      anon_claim: false, auth_claim: false, auth_record: false, auth_complete: false,
      auth_fail: false, auth_finish: false, service_claim: true,
    })
    const id = await reserveNote(db)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(db.query("select * from claim_credit_note_arca($1)", [id]), /FORBIDDEN/)
    await assert.rejects(db.query("select * from complete_credit_note_authorization($1, 3, 1, 'X', '2026-10-10', now(), false, 'homologation')", [id]), /FORBIDDEN/)
    await assert.rejects(db.query("select * from record_credit_note_request($1, 3, 1, 300, '20260927', 'homologation')", [id]), /FORBIDDEN/)
    const legacy = (await db.query<Record<string, boolean>>(`
      select
        to_regprocedure('public.record_credit_note_request(uuid, integer, bigint, numeric, text)') is null as old_record_gone,
        to_regprocedure('public.complete_credit_note_authorization(uuid, integer, bigint, text, date, timestamptz, boolean)') is null as old_complete_gone
    `)).rows[0]
    assert.deepEqual(legacy, { old_record_gone: true, old_complete_gone: true })
  } finally {
    await db.close()
  }
})

// ─────────────── Aislamiento homologación / producción (20260927120000) ───────────────

test("10. NC en el ambiente de su factura: se guarda el ambiente real; otro ambiente se rechaza sin contactar a ARCA", async () => {
  const db = await setup("homologation")
  try {
    const { arca } = recordingArca()
    const id = await reserveNote(db, 300)
    assert.equal((await emit(db, arca, id)).status, "authorized")
    assert.equal((await note(db, id)).arca_environment, "homologation")

    // Producción nunca emite una NC sobre una factura de prueba.
    const production = new FakeArca(POINT, "production")
    const other = await reserveNote(db, 200)
    const crossed = await emitCreditNote(rpcClient(db), {
      noteId: other, gateway: production, pointOfSale: POINT, associatedInvoice: INVOICE, now,
    })
    assert.equal(crossed.status === "failed" && crossed.outcome, "rejected")
    assert.equal(production.requests, 0)
    const row = await note(db, other)
    assert.equal(row.status, "error")
    assert.equal(row.voucher_number, null)
    assert.match(String(row.error), /otro ambiente/)

    // La base lo exige aunque el llamador mienta sobre la factura.
    const direct = await reserveNote(db, 150)
    await db.query("select * from claim_credit_note_arca($1)", [direct])
    await assert.rejects(
      db.query("select * from record_credit_note_request($1, 3, 5, 150, '20260927', 'production')", [direct]),
      /CREDIT_NOTE_ENVIRONMENT_MISMATCH/,
    )
    await assert.rejects(
      db.query("select * from record_credit_note_request($1, 3, 5, 150, '20260927', null)", [direct]),
      /INVALID_CREDIT_NOTE_REQUEST/,
    )
  } finally {
    await db.close()
  }
})

test("11. mismo número de NC permitido en cada ambiente; duplicado en el mismo ambiente rechazado", async () => {
  const db = await setup()
  try {
    const authorize = (environment: string, number: number) => db.query(
      `insert into order_credit_notes (order_id, status, total_amount, items_amount, invoice_point, invoice_number,
         arca_environment, voucher_point, voucher_number, cae, cae_due, authorized_at)
       values (1, 'authorized', 100, 100, $1, 57, $2, $1, $3, 'CAE', '2026-10-10', now())`,
      [POINT, environment, number],
    )
    await authorize("homologation", 9)
    await authorize("production", 9)
    await assert.rejects(authorize("homologation", 9), /order_credit_notes_voucher_unique/)
    // Sin ambiente no se puede guardar un número de NC.
    const bare = await reserveNote(db, 100)
    await assert.rejects(
      db.query("update order_credit_notes set voucher_point=3, voucher_number=10 where id=$1", [bare]),
      /order_credit_notes_arca_environment_required/,
    )
  } finally {
    await db.close()
  }
})

test("12. conciliación NC: un número pedido en homologación nunca se adopta ni libera desde producción", async () => {
  const db = await setup()
  try {
    const id = await reserveNote(db, 300)
    await db.query(
      "update order_credit_notes set arca_environment='homologation', voucher_point=$2, voucher_number=1, requested_total=300, requested_date='20260927' where id=$1",
      [id, POINT],
    )
    const production = new FakeArca(POINT, "production")
    production.vouchers.set(1, { total: 300, cae: "CAE-PROD", caeDue: "20261010", date: "20260927", associated: [ASSOCIATED] })
    const result = await reconcileCreditNote(rpcClient(db), { noteId: id, gateway: production })
    assert.equal(result.status === "failed" && result.outcome, "manual_review")
    const row = await note(db, id)
    assert.equal(row.cae, null)
    assert.equal(row.status, "processing", "no se libera")
    assert.equal(Number(row.voucher_number), 1)
    assert.match(String(row.error), /No se concilia entre ambientes/)
    assert.equal(production.requests, 0)
  } finally {
    await db.close()
  }
})

test("13. datos existentes: NC con comprobante quedan como homologation; sin número, sin ambiente", async () => {
  const db = new PGlite()
  try {
    await db.exec(read("lib/arca/fixtures/arca-credit-note-schema.sql"))
    await db.exec(read("supabase/migrations/20260927110000_arca_credit_note_hardening.sql"))
    await db.query(
      "insert into ordenes (id, invoice_status, invoice_point, invoice_number, invoice_cae) values (1, 'authorized', 1, 61, 'CAE-F61')",
    )
    const authorized = (await db.query<{ id: string }>(
      `insert into order_credit_notes (order_id, status, total_amount, items_amount, invoice_point, invoice_number,
         voucher_point, voucher_number, cae, cae_due, authorized_at)
       values (1, 'authorized', 100, 100, 1, 61, 1, 9, 'CAE-NC9', '2026-08-06', now()) returning id`)).rows[0].id
    const released = (await db.query<{ id: string }>(
      `insert into order_credit_notes (order_id, status, total_amount, items_amount, invoice_point, invoice_number)
       values (1, 'error', 50, 50, 1, 61) returning id`)).rows[0].id

    await db.exec(read("supabase/migrations/20260927120000_arca_environment_isolation.sql"))

    assert.equal((await note(db, authorized)).arca_environment, "homologation")
    assert.equal((await note(db, released)).arca_environment, null)
    assert.equal(
      (await db.query<{ env: string }>("select invoice_arca_environment as env from ordenes where id=1")).rows[0].env,
      "homologation",
    )
  } finally {
    await db.close()
  }
})
