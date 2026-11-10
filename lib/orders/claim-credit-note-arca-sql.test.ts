import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { insertRefundProof } from "./fixtures/claim-compensation-evidence.ts"
import {
  CLAIM_FISCAL_CHAIN,
  admin,
  claimStatus,
  close,
  createClaim,
  mutate,
  one,
  setup,
  type Db,
  type Row,
} from "./fixtures/claim-financial-db.ts"

// Compatibilidad integral con ARCA: la cadena REAL de NC (lease, número pedido,
// autorización, finalización), la liquidación Mercado Pago real y las guardas
// fiscales (CAE) conviven con las guardas de 20261106120000, aplicadas en el
// orden cronológico real (CLAIM_FISCAL_CHAIN). ARCA no se contacta: la
// respuesta fiscal (CAE, vencimiento) es simulada y entra por las mismas RPC
// que usa lib/arca/credit-note-emission.ts.

const IMMUTABLE = /CREDIT_NOTE_AUTHORIZED_IMMUTABLE|CREDIT_NOTE_CAE_IMMUTABLE|CREDIT_NOTE_CLAIM_IMMUTABLE/
const ENV = "homologation"
const POINT = 4
let nextNumber = 300

/** NC 'processing' como la crea la ruta de NC (encabezado + renglón, asociada a la Factura C del pedido). */
async function processingNote(db: Db, { claimId, orderId = 1, orderItemId = 1, total = 2000 }: { claimId: number | null; orderId?: number; orderItemId?: number; total?: number }) {
  await db.query("begin")
  try {
    const note = await one<{ id: string }>(db, `insert into order_credit_notes(order_id,claim_id,status,destination,reason,reason_code,resolution_type,
        items_amount,manual_amount,total_amount,external_amount,invoice_point,invoice_number,settlement_status)
      values($1::bigint,$2::bigint,'processing','external_refund','Reintegro parcial acordado','producto_defectuoso','medio_pago',$3::numeric,0,$3::numeric,$3::numeric,3,100+$1::bigint,'pendiente') returning id`,
    [orderId, claimId, total])
    await db.query("insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,$2,1,$3,$3)", [note.id, orderItemId, total])
    await db.query("commit")
    return note.id
  } catch (error) {
    await db.query("rollback")
    throw error
  }
}

/** Lease + número pedido (record_credit_note_request) antes de FECAESolicitar. */
async function requestArca(db: Db, noteId: string, total = 2000) {
  nextNumber += 1
  await db.query("select * from claim_credit_note_arca($1)", [noteId])
  await db.query("select * from record_credit_note_request($1,$2,$3,$4,'20261110',$5)", [noteId, POINT, nextNumber, total, ENV])
  return nextNumber
}
/** Respuesta fiscal simulada persistida por complete_credit_note_authorization. */
const authorize = (db: Db, noteId: string, number: number, { cae = `CAE-NC-${number}`, environment = ENV, point = POINT } = {}) =>
  one(db, "select * from complete_credit_note_authorization($1,$2,$3,$4,'2026-11-20',now(),false,$5)", [noteId, point, number, cae, environment])

const FISCAL = ["order_id", "claim_id", "reason", "reason_code", "resolution_type", "destination", "total_amount", "items_amount", "manual_amount",
  "external_amount", "invoice_point", "invoice_number", "voucher_point", "voucher_number", "cae", "cae_due", "authorized_at", "arca_environment", "requested_total"]
const fiscalSnapshot = async (db: Db, noteId: string) => {
  const row = await one(db, "select * from order_credit_notes where id=$1", [noteId])
  return Object.fromEntries(FISCAL.map((key) => [key, row[key] === null || row[key] === undefined ? null : String(row[key])]))
}
const events = async (db: Db, action: string) =>
  Number((await one<{ n: number }>(db, "select count(*)::int n from order_audit_events where action=$1", [action])).n)
const confirmMercadoPagoRefund = (db: Db, orderId: number, amount: number) =>
  db.query("insert into mercadopago_order_refunds(order_id,payment_id,amount,status,mp_refund_id,idempotency_key,requested_by,completed_at) values($1,$2,$3,'confirmed',$4,$5,$6,now())",
    [orderId, `pay-${orderId}`, amount, `mp-${randomUUID().slice(0, 8)}`, randomUUID(), admin])

async function partialRefundClaim(db: Db, orderId = 1, orderItemId = 1) {
  const id = await createClaim(db, orderId, [{ order_item_id: orderItemId, quantity: 1 }])
  await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_parcial" })
  return id
}

test("cadena fiscal real: orden cronológico y guardas presentes", async () => {
  const db = await setup({ fiscal: true })
  try {
    assert.deepEqual(CLAIM_FISCAL_CHAIN, [...CLAIM_FISCAL_CHAIN].sort())
    const triggers = (await db.query<{ tgname: string }>(
      "select tgname from pg_trigger where tgrelid='public.order_credit_notes'::regclass and not tgisinternal order by tgname")).rows.map((row) => row.tgname)
    for (const name of ["aa_guard_credit_note_authorized_immutable", "aa_guard_credit_note_cae_immutable", "guard_order_credit_note_compensation_evidence",
      "settle_credit_notes_on_credit_note_authorized", "zz_allocate_order_credit_note_refund"]) {
      assert.ok(triggers.includes(name), name)
    }
  } finally {
    await db.close()
  }
})

test("ARCA: emisión, autorización, reintento idempotente, finalización y liquidación MP sin tocar lo fiscal", async () => {
  const db = await setup({ fiscal: true })
  try {
    const claimId = await partialRefundClaim(db)
    const noteId = await processingNote(db, { claimId })
    const number = await requestArca(db, noteId)
    const authorized = await authorize(db, noteId, number)
    assert.deepEqual([authorized.status, authorized.cae, Number(authorized.voucher_number), authorized.arca_environment, authorized.settlement_status],
      ["authorized", `CAE-NC-${number}`, number, ENV, "pendiente"])
    const snapshot = await fiscalSnapshot(db, noteId)
    assert.equal(await events(db, "credit_note_arca_authorized"), 1)

    // Reintento con la misma respuesta (reconciliación): idempotente, sin evento nuevo ni cambios.
    const retried = await authorize(db, noteId, number)
    assert.equal(retried.status, "authorized")
    assert.equal(await events(db, "credit_note_arca_authorized"), 1)
    // Otro proceso mientras el lease sigue vigente: no entra. Lease vencido (proceso caído
    // tras autorizar): se reanuda la finalización. Se finaliza una sola vez.
    await assert.rejects(db.query("select * from claim_credit_note_arca($1)", [noteId]), /CREDIT_NOTE_ALREADY_PROCESSING/)
    await db.query("update order_credit_notes set arca_claimed_until=now()-interval '1 minute' where id=$1", [noteId])
    await db.query("select * from claim_credit_note_arca($1)", [noteId])
    assert.equal((await one(db, "select finish_credit_note_finalization($1) ok", [noteId])).ok, true)
    assert.equal((await one(db, "select finish_credit_note_finalization($1) ok", [noteId])).ok, false)
    await assert.rejects(db.query("select * from claim_credit_note_arca($1)", [noteId]), /CREDIT_NOTE_ALREADY_FINALIZED/)
    assert.deepEqual(await fiscalSnapshot(db, noteId), snapshot)

    // Liquidación real: refund MP confirmado -> settle_credit_notes_after_mercadopago_refund (trigger).
    await confirmMercadoPagoRefund(db, 1, 2000)
    const settled = await one(db, "select settlement_status, management_status, settlement_reference from order_credit_notes where id=$1", [noteId])
    assert.equal(settled.settlement_status, "completado")
    assert.match(String(settled.settlement_reference), /^mp_refund:/)
    assert.equal(Number((await one<{ s: string }>(db, "select sum(amount) s from order_credit_note_refund_allocations where credit_note_id=$1", [noteId])).s), 2000)
    assert.equal(await events(db, "credit_note_settled_by_mp_refund"), 1)
    // Conciliación repetida: no liquida ni asigna dos veces.
    assert.equal(Number((await one(db, "select settle_credit_notes_after_mercadopago_refund(1) n")).n), 0)
    assert.equal(Number((await one<{ n: number }>(db, "select count(*)::int n from order_credit_note_refund_allocations where credit_note_id=$1", [noteId])).n), 1)
    assert.deepEqual(await fiscalSnapshot(db, noteId), snapshot, "la liquidación no toca campos fiscales")

    await close(db, claimId)
    assert.equal(await claimStatus(db, claimId), "cerrado")
  } finally {
    await db.close()
  }
})

test("ARCA negativos: otro CAE/ambiente/número, datos inconsistentes y alteraciones posteriores", async () => {
  const db = await setup({ fiscal: true })
  try {
    const claimId = await partialRefundClaim(db)
    const other = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
    const noteId = await processingNote(db, { claimId })
    // Antes de pedir el número: importe distinto al de la NC o sin lease.
    await assert.rejects(db.query("select * from record_credit_note_request($1,$2,999,1000,'20261110',$3)", [noteId, POINT, ENV]), /CREDIT_NOTE_NOT_CLAIMED/)
    await db.query("select * from claim_credit_note_arca($1)", [noteId])
    await assert.rejects(db.query("select * from record_credit_note_request($1,$2,999,1000,'20261110',$3)", [noteId, POINT, ENV]), /CREDIT_NOTE_AMOUNT_MISMATCH/)
    await assert.rejects(db.query("select * from record_credit_note_request($1,$2,999,2000,'20261110','production')", [noteId, POINT]), /CREDIT_NOTE_ENVIRONMENT_MISMATCH/)
    nextNumber += 1
    const number = nextNumber
    await db.query("select * from record_credit_note_request($1,$2,$3,2000,'20261110',$4)", [noteId, POINT, number, ENV])
    // Autorización inconsistente con lo pedido.
    await assert.rejects(authorize(db, noteId, number + 1), /CREDIT_NOTE_AUTHORIZATION_DOES_NOT_MATCH_REQUEST/)
    await assert.rejects(authorize(db, noteId, number, { point: POINT + 1 }), /CREDIT_NOTE_AUTHORIZATION_DOES_NOT_MATCH_REQUEST/)
    await assert.rejects(authorize(db, noteId, number, { environment: "production" }), /CREDIT_NOTE_AUTHORIZATION_DOES_NOT_MATCH_REQUEST/)
    await assert.rejects(authorize(db, noteId, number, { environment: "staging" }), /INVALID_CREDIT_NOTE_AUTHORIZATION/)
    await assert.rejects(authorize(db, noteId, number, { cae: " " }), /INVALID_CREDIT_NOTE_AUTHORIZATION/)
    await authorize(db, noteId, number)
    const snapshot = await fiscalSnapshot(db, noteId)

    // Reintento con otra respuesta: rechazado.
    await assert.rejects(authorize(db, noteId, number, { cae: "CAE-OTRO" }), /CREDIT_NOTE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER/)
    await assert.rejects(authorize(db, noteId, number, { environment: "production" }), /CREDIT_NOTE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER/)
    await assert.rejects(authorize(db, noteId, number + 5), /CREDIT_NOTE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER/)
    // UPDATE directo sobre la NC autorizada.
    for (const [label, set, params] of [
      ["importe", "total_amount=1000, items_amount=1000, external_amount=1000", []],
      ["reclamo -> NULL", "claim_id=null", []],
      ["otro reclamo", "claim_id=$2", [other]],
      ["motivo", "reason='Motivo reescrito'", []],
      ["motivo comercial", "reason_code='otro', resolution_type='saldo_favor'", []],
      ["ambiente fiscal", "arca_environment='production'", []],
      ["comprobante", "voucher_number=voucher_number+1", []],
      ["punto", "voucher_point=9", []],
      ["CAE", "cae='CAE-FALSO'", []],
      ["vencimiento CAE", "cae_due='2030-01-01'", []],
      ["factura asociada", "invoice_number=999", []],
      ["volver a procesar", "status='processing'", []],
      ["todo junto", "claim_id=null, reason='x', total_amount=1000, items_amount=1000, status='error'", []],
    ] as const) {
      await assert.rejects(db.query(`update order_credit_notes set ${set} where id=$1`, [noteId, ...params]), IMMUTABLE, label)
    }
    assert.deepEqual(await fiscalSnapshot(db, noteId), snapshot)

    // Liquidación inválida: dinero insuficiente nunca liquida ni cierra.
    await confirmMercadoPagoRefund(db, 1, 1000)
    assert.equal((await one(db, "select settlement_status from order_credit_notes where id=$1", [noteId])).settlement_status, "pendiente")
    const proof = await insertRefundProof(db, 1, 500)
    await assert.rejects(db.query("update order_credit_notes set settlement_status='completado', settlement_reference=$2 where id=$1", [noteId, String(proof)]),
      /CREDIT_NOTE_REFUND_EVIDENCE_EXHAUSTED/)
    await assert.rejects(close(db, claimId), /CLAIM_REFUND_PENDING/)
    assert.deepEqual(await fiscalSnapshot(db, noteId), snapshot)
  } finally {
    await db.close()
  }
})

test("ARCA: NC rechazada por ARCA vuelve a proceso sin guardas fiscales en el medio; asociación legítima antes de autorizar", async () => {
  const db = await setup({ fiscal: true })
  try {
    const claimId = await partialRefundClaim(db)
    const noteId = await processingNote(db, { claimId })
    await requestArca(db, noteId)
    // Rechazo de ARCA: libera el número (campos fiscales vuelven a null) — la NC nunca estuvo autorizada.
    await db.query("select fail_credit_note_arca_attempt($1,'Rechazada por ARCA','rejected')", [noteId])
    const failed = await one(db, "select status, voucher_number, arca_environment from order_credit_notes where id=$1", [noteId])
    assert.deepEqual([failed.status, failed.voucher_number, failed.arca_environment], ["error", null, null])

    // Nueva NC en proceso: el motivo se corrige antes de autorizar.
    const second = await processingNote(db, { claimId })
    await db.query("update order_credit_notes set reason='Reintegro parcial por falla parcial', reason_detail='Acordado por chat' where id=$1", [second])
    const number = await requestArca(db, second)
    const authorized = await authorize(db, second, number)
    assert.deepEqual([authorized.reason, Number(authorized.claim_id)], ["Reintegro parcial por falla parcial", claimId])
  } finally {
    await db.close()
  }
})

test("ARCA: NC histórica autorizada sin reclamo sigue válida y se liquida", async () => {
  const db = await setup({ fiscal: true })
  try {
    const note = await one<{ id: string }>(db, `insert into order_credit_notes(order_id,claim_id,status,destination,reason,items_amount,manual_amount,total_amount,
        invoice_point,invoice_number,voucher_point,voucher_number,cae,cae_due,authorized_at,arca_environment,settlement_status)
      values(2,null,'authorized','external_refund','Nota de crédito histórica migrada',800,0,800,3,102,4,77,'CAE-HIST','2026-09-01',now()-interval '60 days','homologation','pendiente') returning id`)
    await confirmMercadoPagoRefund(db, 2, 800)
    const row = await one<Row>(db, "select status, settlement_status, cae from order_credit_notes where id=$1", [note.id])
    assert.deepEqual([row.status, row.settlement_status, row.cae], ["authorized", "completado", "CAE-HIST"])
    await assert.rejects(db.query("update order_credit_notes set reason='Otro' where id=$1", [note.id]), IMMUTABLE)
  } finally {
    await db.close()
  }
})
