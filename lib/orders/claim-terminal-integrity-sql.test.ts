import assert from "node:assert/strict"
import test from "node:test"
import {
  authorizedClaimNote,
  insertRefundProof,
  markSettledWithoutEvidence,
  refundWithMercadoPago,
  refundWithProof,
} from "./fixtures/claim-compensation-evidence.ts"
import {
  admin,
  claimStatus,
  close,
  compensate,
  createClaim,
  customer,
  mutate,
  one,
  setup,
  version,
  type Db,
  type Row,
} from "./fixtures/claim-financial-db.ts"

// Postauditoría (Codex): integridad de reclamos terminales y NC autorizadas.
//   P1-1 un reclamo rechazado sólo sale de 'rechazado' por reopen_rejected_order_claim
//        (autorización verificable de la propia transacción, no un flag de sesión);
//   P1-2 una NC autorizada (CAE) conserva sus importes, desglose y datos fiscales;
//   P2   lo visible de un reclamo terminal (resumen, motivos, respuesta) no se reescribe.
// Cadena REAL de migraciones (PGlite).

const REOPEN_UNAUTHORIZED = /CLAIM_REOPEN_UNAUTHORIZED/
const TERMINAL = /CLAIM_TERMINAL_IMMUTABLE/
const NOTE_IMMUTABLE = /CREDIT_NOTE_AUTHORIZED_IMMUTABLE/
const REASON = "Me equivoqué: el reclamo sí corresponde"

const reject = (db: Db, id: number) =>
  mutate(db, id, { status: "rechazado", resolution: "rechazado", rejection_reason: "No corresponde: daño por mal uso." })
const reopen = async (db: Db, id: number, { reason = REASON, actor = admin }: { reason?: string | null; actor?: string } = {}) =>
  (await db.query<Row>("select * from reopen_rejected_order_claim($1,$2,$3::timestamptz,$4)", [id, actor, await version(db, id), reason])).rows[0]
const claim = (db: Db, id: number) => one(db, "select * from order_claims where id=$1", [id])
const grants = async (db: Db, id: number) =>
  Number((await one<{ n: number }>(db, "select count(*)::int n from order_claim_reopen_authorizations where claim_id=$1", [id])).n)

async function rejectedClaim(db: Db, orderId = 1) {
  const id = await createClaim(db, orderId, [{ order_item_id: orderId === 2 ? 4 : 1, quantity: 1 }])
  await reject(db, id)
  return id
}

// ---------------------------------------------------------------------------
// P1-1 Reapertura de reclamos rechazados
// ---------------------------------------------------------------------------

test("P1-1 reproducción: un UPDATE directo nunca saca un reclamo de 'rechazado'", async () => {
  const db = await setup()
  try {
    const id = await rejectedClaim(db)
    // El hallazgo de Codex: reabrir y elegir solución en el mismo UPDATE.
    await assert.rejects(db.query("update order_claims set status='en_revision', resolution='saldo_a_favor' where id=$1", [id]), REOPEN_UNAUTHORIZED)
    // Exactamente lo que hace la RPC, sin pasar por ella.
    await assert.rejects(db.query(
      "update order_claims set status='en_revision', resolution=null, rejection_reason=null, closed_at=null, resolution_summary=null where id=$1", [id]),
    REOPEN_UNAUTHORIZED)
    // Cualquier otro destino, también los intermedios.
    for (const status of ["recibido", "falta_informacion", "aprobado", "reintegro_pendiente", "cupon_pendiente", "cerrado"]) {
      await assert.rejects(db.query("update order_claims set status=$2 where id=$1", [id, status]), REOPEN_UNAUTHORIZED, status)
    }
    // Saltos en la misma transacción (rechazado -> X -> Y): el primero ya se rechaza.
    await db.query("begin")
    await assert.rejects(db.query("update order_claims set status='en_revision' where id=$1", [id]), REOPEN_UNAUTHORIZED)
    await db.query("rollback")
    const row = await claim(db, id)
    assert.deepEqual([row.status, row.resolution], ["rechazado", "rechazado"])
  } finally {
    await db.close()
  }
})

test("P1-1 rechazado: lo comercial no cambia mientras siga rechazado (resolución, tipo, motivo, resumen)", async () => {
  const db = await setup()
  try {
    const id = await rejectedClaim(db)
    for (const [column, value] of [
      ["resolution", "saldo_a_favor"],
      ["failure_type", "otro"],
      ["rejection_reason", "Otro motivo distinto"],
      ["resolution_summary", JSON.stringify({ kind: "saldo_a_favor", label: "Saldo a favor" })],
      ["admin_response", "Te acreditamos $ 99.999"],
      ["closed_at", null],
      ["claim_type", "otro"],
      ["affected_items", "[]"],
    ] as const) {
      await assert.rejects(db.query(`update order_claims set ${column}=$2 where id=$1`, [id, value]), TERMINAL, column)
    }
    // La atención del Admin y la actividad siguen funcionando sobre un reclamo terminal.
    await db.query("update order_claims set admin_needs_action=true, last_customer_message_at=now() where id=$1", [id])
  } finally {
    await db.close()
  }
})

test("P1-1 la autorización de reapertura no se fabrica ni se reutiliza", async () => {
  const db = await setup()
  try {
    const id = await rejectedClaim(db)
    // Ni anon, authenticated ni service_role pueden escribir (ni leer) la autorización.
    const privileges = (await db.query<Record<string, boolean>>(`select
      has_table_privilege('anon','public.order_claim_reopen_authorizations','INSERT') a,
      has_table_privilege('authenticated','public.order_claim_reopen_authorizations','INSERT') b,
      has_table_privilege('service_role','public.order_claim_reopen_authorizations','INSERT') c,
      has_table_privilege('service_role','public.order_claim_reopen_authorizations','UPDATE') d,
      has_table_privilege('service_role','public.order_claim_reopen_authorizations','DELETE') e`)).rows[0]
    assert.deepEqual(privileges, { a: false, b: false, c: false, d: false, e: false })
    await db.query("set role service_role")
    try {
      await assert.rejects(db.query("insert into order_claim_reopen_authorizations(claim_id,actor_id,reason) values($1,$2,$3)", [id, admin, REASON]),
        /permission denied/)
    } finally {
      await db.query("reset role")
    }
    // Una variable de sesión no autoriza nada.
    await db.query("select set_config('beyonix.claim_reopen', $1, false)", [String(id)])
    await assert.rejects(db.query("update order_claims set status='en_revision', resolution=null, rejection_reason=null, closed_at=null, resolution_summary=null where id=$1", [id]),
      REOPEN_UNAUTHORIZED)

    // Una reapertura legítima consume su autorización: no sirve para un segundo rechazo -> reapertura.
    await reopen(db, id)
    const used = await one(db, "select actor_id, reason, consumed_at from order_claim_reopen_authorizations where claim_id=$1", [id])
    assert.equal(used.actor_id, admin)
    assert.equal(used.reason, REASON)
    assert.ok(used.consumed_at)
    await reject(db, id)
    await assert.rejects(db.query("update order_claims set status='en_revision', resolution=null, rejection_reason=null, closed_at=null, resolution_summary=null where id=$1", [id]),
      REOPEN_UNAUTHORIZED)
    assert.equal(await claimStatus(db, id), "rechazado")
  } finally {
    await db.close()
  }
})

test("P1-1 reapertura legítima: Admin, motivo, sin efectos; audita actor, fecha y motivo", async () => {
  const db = await setup()
  try {
    const id = await rejectedClaim(db)
    const reopened = await reopen(db, id)
    assert.deepEqual([reopened.status, reopened.resolution, reopened.rejection_reason, reopened.closed_at, reopened.resolution_summary],
      ["en_revision", null, null, null, null])
    const event = await one(db, "select actor_id, metadata, created_at from order_audit_events where action='claim_review_reopened'")
    assert.equal(event.actor_id, admin)
    assert.ok(event.created_at)
    assert.match(JSON.stringify(event.metadata), /Me equivoqué.*No corresponde: daño por mal uso/)
    const authorization = await one(db, "select actor_id, reason, created_at, consumed_at from order_claim_reopen_authorizations where claim_id=$1", [id])
    assert.deepEqual([authorization.actor_id, authorization.reason], [admin, REASON])
    assert.ok(authorization.created_at && authorization.consumed_at)
    // Sigue el flujo normal de un reclamo abierto.
    await mutate(db, id, { status: "aprobado", resolution: "saldo_a_favor" })
    assert.equal(await claimStatus(db, id), "aprobado")
  } finally {
    await db.close()
  }
})

test("P1-1 reapertura rechazada: sin permisos, sin motivo, con efectos; nunca deja autorizaciones", async () => {
  const db = await setup()
  try {
    const id = await rejectedClaim(db)
    await assert.rejects(reopen(db, id, { actor: customer }), /CLAIM_FORBIDDEN/)
    const operator = "21000000-0000-4000-8000-000000000009"
    await db.query("insert into auth.users values($1,'op@example.test',now())", [operator])
    await db.query("insert into profiles(id,email,rol) values($1,'op@example.test','operador')", [operator])
    await assert.rejects(reopen(db, id, { actor: operator }), /CLAIM_FORBIDDEN/, "sólo Admin")
    await assert.rejects(reopen(db, id, { reason: null }), /CLAIM_REOPEN_REASON_REQUIRED/)
    await assert.rejects(reopen(db, id, { reason: "corto" }), /CLAIM_REOPEN_REASON_REQUIRED/)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(reopen(db, id), /CLAIM_FORBIDDEN/)
    await db.query("select set_config('request.jwt.claim.role','service_role',false)")
    // Con un efecto real (saldo a favor del reclamo).
    await db.query("insert into customer_credit_movements(user_id,order_id,claim_id,source_type,movement_type,amount) values($1,1,$2,'credit_note','credit',1000)", [customer, id])
    await assert.rejects(reopen(db, id), /CLAIM_REOPEN_HAS_EFFECTS/)
    assert.equal(await grants(db, id), 0)
    assert.equal(await claimStatus(db, id), "rechazado")
  } finally {
    await db.close()
  }
})

// ---------------------------------------------------------------------------
// P2 / terminales: cerrado y cancelado
// ---------------------------------------------------------------------------

test("P2 reproducción: el resumen visible de un reclamo finalizado no se reescribe", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }])
    await mutate(db, id, { status: "aprobado", resolution: "saldo_a_favor" })
    // Mientras está abierto, el resumen se puede editar (al cerrar se recalcula).
    await db.query("update order_claims set resolution_summary=$2 where id=$1", [id, JSON.stringify({ label: "borrador" })])
    await compensate(db, id, "customer_balance", 1, 1)
    await close(db, id)
    const frozen = (await claim(db, id)).resolution_summary
    assert.notDeepEqual(frozen, { label: "borrador" }, "el cierre congela el resumen real")
    for (const [column, value] of [
      ["resolution_summary", JSON.stringify({ kind: "reintegro_total", label: "Reintegro de $ 999.999" })],
      ["resolution_summary", null],
      ["admin_response", "Te devolvimos $ 999.999"],
      ["rejection_reason", "x"],
      ["closed_at", null],
      ["refund_amount_confirmed", "999999"],
      ["cancellation_reason", "Cancelado retroactivamente"],
      ["claim_type", "otro"],
    ] as const) {
      await assert.rejects(db.query(`update order_claims set ${column}=$2 where id=$1`, [id, value]), TERMINAL, column)
    }
    assert.deepEqual((await claim(db, id)).resolution_summary, frozen)
  } finally {
    await db.close()
  }
})

test("terminales: cerrado y cancelado siguen inmutables; un abierto conserva sus transiciones", async () => {
  const db = await setup()
  try {
    const closed = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }])
    await mutate(db, closed, { status: "aprobado", resolution: "saldo_a_favor" })
    await compensate(db, closed, "customer_balance", 1, 1)
    await close(db, closed)
    for (const status of ["en_revision", "rechazado", "aprobado"]) {
      await assert.rejects(db.query("update order_claims set status=$2 where id=$1", [closed, status]), TERMINAL)
    }
    await assert.rejects(reopen(db, closed), /CLAIM_REOPEN_NOT_ALLOWED/)

    const cancelled = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
    await db.query("select * from cancel_order_claim($1,$2,$3::timestamptz,$4)", [cancelled, admin, await version(db, cancelled), "El cliente desistió del reclamo"])
    const row = await claim(db, cancelled)
    assert.ok(row.cancelled_at)
    for (const [column, value] of [["status", "en_revision"], ["cancelled_at", null], ["cancellation_reason", "Otro motivo cualquiera"], ["resolution_summary", null]] as const) {
      await assert.rejects(db.query(`update order_claims set ${column}=$2 where id=$1`, [cancelled, value]), TERMINAL, column)
    }
    await assert.rejects(reopen(db, cancelled), /CLAIM_REOPEN_NOT_ALLOWED/)

    // Abierto: recibido -> en_revision -> falta_informacion -> en_revision -> rechazado.
    const open = await createClaim(db, 3, [{ order_item_id: 5, quantity: 1 }], "21000000-0000-4000-8000-000000000002")
    for (const status of ["en_revision", "falta_informacion", "en_revision"]) {
      await mutate(db, open, { status })
      assert.equal(await claimStatus(db, open), status)
    }
    await reject(db, open)
    assert.equal(await claimStatus(db, open), "rechazado")
  } finally {
    await db.close()
  }
})

// ---------------------------------------------------------------------------
// P1-2 Importes de una NC autorizada
// ---------------------------------------------------------------------------

async function partialRefundClaim(db: Db) {
  const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }])
  await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_parcial" })
  const note = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }], amount: 2000, externalAmount: 2000 })
  return { id, noteId: note.id }
}
const noteOf = (db: Db, noteId: string) => one(db, "select * from order_credit_notes where id=$1", [noteId])

test("P1-2 reproducción: una NC autorizada de $2.000 no baja a $1.000 para cerrar con un comprobante menor", async () => {
  const db = await setup()
  try {
    const { id, noteId } = await partialRefundClaim(db)
    await assert.rejects(db.query("update order_credit_notes set total_amount=1000, items_amount=1000, external_amount=1000 where id=$1", [noteId]), NOTE_IMMUTABLE)
    // El comprobante de $1.000 no alcanza para liquidar la NC de $2.000.
    const proof = await insertRefundProof(db, 1, 1000)
    await assert.rejects(markSettledWithoutEvidence(db, noteId, String(proof)), /CREDIT_NOTE_REFUND_EVIDENCE_EXHAUSTED/)
    await assert.rejects(close(db, id), /CLAIM_REFUND_PENDING/)
    const note = await noteOf(db, noteId)
    assert.deepEqual([Number(note.total_amount), Number(note.external_amount), note.settlement_status], [2000, 2000, "pendiente"])
    assert.equal(await claimStatus(db, id), "reintegro_pendiente")
  } finally {
    await db.close()
  }
})

test("P1-2 NC autorizada: importes, desglose y datos fiscales congelados (subir, bajar, junto con el estado)", async () => {
  const db = await setup()
  try {
    const { noteId } = await partialRefundClaim(db)
    for (const [column, value] of [
      ["total_amount", 1000], ["total_amount", 3000], ["items_amount", 1500], ["manual_amount", 500],
      ["external_amount", 1000], ["external_amount", null], ["customer_credit_amount", 500],
      ["destination", "customer_balance"], ["order_id", 2], ["voucher_number", 999999], ["voucher_point", 9],
      ["invoice_point", 7], ["invoice_number", 7], ["authorized_at", null],
    ] as const) {
      await assert.rejects(db.query(`update order_credit_notes set ${column}=$2 where id=$1`, [noteId, value]), NOTE_IMMUTABLE, column)
    }
    await assert.rejects(db.query("update order_credit_notes set cae='OTRO' where id=$1", [noteId]), /CREDIT_NOTE_CAE_IMMUTABLE|CREDIT_NOTE_AUTHORIZED_IMMUTABLE/)
    await assert.rejects(db.query("update order_credit_notes set status='processing', total_amount=1000 where id=$1", [noteId]), NOTE_IMMUTABLE)
    await assert.rejects(db.query("delete from order_credit_notes where id=$1", [noteId]), /CREDIT_NOTE_AUTHORIZED_IMMUTABLE|violates foreign key/)
    // Renglones de una NC autorizada: ya inmutables.
    await assert.rejects(db.query("update order_credit_note_items set total_amount=1000, unit_amount=1000 where credit_note_id=$1", [noteId]), /CREDIT_NOTE_ITEMS_LOCKED/)
    const note = await noteOf(db, noteId)
    assert.equal(Number(note.total_amount), 2000)
  } finally {
    await db.close()
  }
})

test("P1 NC autorizada: nunca se desvincula, cambia de reclamo ni de motivo (solos o junto con otros campos)", async () => {
  const db = await setup()
  try {
    const { id, noteId } = await partialRefundClaim(db)
    const other = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
    const reason = (await noteOf(db, noteId)).reason
    for (const [label, sql, params] of [
      ["claim_id -> NULL", "update order_credit_notes set claim_id=null where id=$1", [noteId]],
      ["claim_id -> otro reclamo", "update order_credit_notes set claim_id=$2 where id=$1", [noteId, other]],
      ["reason distinto", "update order_credit_notes set reason='Motivo reescrito' where id=$1", [noteId]],
      ["reclamo + motivo + importes", "update order_credit_notes set claim_id=null, reason='Otro', total_amount=1000, external_amount=1000 where id=$1", [noteId]],
      ["estado + asociación", "update order_credit_notes set status='error', claim_id=null where id=$1", [noteId]],
      ["asociación + liquidación", "update order_credit_notes set claim_id=null, settlement_status='completado' where id=$1", [noteId]],
    ] as const) {
      await assert.rejects(db.query(sql, [...params]), /CREDIT_NOTE_AUTHORIZED_IMMUTABLE|CREDIT_NOTE_CLAIM_IMMUTABLE/, label)
    }
    // Borrar el reclamo (FK ON DELETE SET NULL) tampoco la desvincula.
    await assert.rejects(db.query("delete from order_claims where id=$1", [id]))
    const note = await noteOf(db, noteId)
    assert.deepEqual([Number(note.claim_id), note.reason, Number(note.total_amount), note.status], [id, reason, 2000, "authorized"])
  } finally {
    await db.close()
  }
})

test("P1 NC en proceso: asociación y motivo siguen sus reglas existentes antes de autorizar", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }])
    await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_parcial" })
    const other = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
    const noteId = (await one<{ id: string }>(db,
      "insert into order_credit_notes(order_id,claim_id,status,destination,reason,total_amount,external_amount,settlement_status) values(1,$1,'processing','external_refund','Reintegro parcial',2000,2000,'pendiente') returning id", [id])).id
    await db.query("insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,1,1,2000,2000)", [noteId])
    await db.query("update order_credit_notes set reason='Reintegro parcial acordado con el cliente' where id=$1", [noteId])
    await assert.rejects(db.query("update order_credit_notes set claim_id=$2 where id=$1", [noteId, other]), /CREDIT_NOTE_CLAIM_IMMUTABLE/, "regla existente")
    // Autorizar cambiando la asociación o el motivo en el mismo UPDATE: rechazado.
    const authorize = "update order_credit_notes set status='authorized', cae='CAE-9', voucher_point=1, voucher_number=909, authorized_at=now()"
    await assert.rejects(db.query(`${authorize}, claim_id=null where id=$1`, [noteId]), NOTE_IMMUTABLE)
    await assert.rejects(db.query(`${authorize}, reason='Otro' where id=$1`, [noteId]), NOTE_IMMUTABLE)
    await db.query(`${authorize} where id=$1`, [noteId])
    const note = await noteOf(db, noteId)
    assert.deepEqual([note.status, Number(note.claim_id), note.reason], ["authorized", id, "Reintegro parcial acordado con el cliente"])
    // Liquidación posterior y reintento idempotente: permitidos.
    await refundWithProof(db, [noteId])
    await markSettledWithoutEvidence(db, noteId)
    await close(db, id)
    assert.equal(await claimStatus(db, id), "cerrado")
    // Reclamo cerrado: la evidencia sigue protegida.
    await assert.rejects(db.query("update order_credit_notes set settlement_status='pendiente' where id=$1", [noteId]), /CLAIM_COMPENSATION_EVIDENCE_LOCKED/)
  } finally {
    await db.close()
  }
})

test("P1 NC histórica autorizada (sin reclamo): sigue válida, se liquida y conserva su motivo", async () => {
  const db = await setup()
  try {
    const noteId = (await one<{ id: string }>(db, `insert into order_credit_notes(order_id,claim_id,status,destination,reason,total_amount,external_amount,cae,voucher_point,voucher_number,authorized_at,settlement_status)
      values(2,null,'authorized','external_refund','Nota de crédito histórica migrada',500,500,'CAE-HIST',1,555,now()-interval '60 days','pendiente') returning id`)).id
    await db.query("update order_credit_notes set settlement_status='completado', management_status='finalizada', settlement_reference='legacy-transfer' where id=$1", [noteId])
    await assert.rejects(db.query("update order_credit_notes set reason='Otro' where id=$1", [noteId]), NOTE_IMMUTABLE)
    const claimId = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
    await assert.rejects(db.query("update order_credit_notes set claim_id=$2 where id=$1", [noteId, claimId]), /CREDIT_NOTE_AUTHORIZED_IMMUTABLE|CREDIT_NOTE_CLAIM_IMMUTABLE/)
    assert.equal((await noteOf(db, noteId)).settlement_status, "completado")
  } finally {
    await db.close()
  }
})

test("P1-2 autorizar y cambiar el importe en el mismo UPDATE: rechazado", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }])
    await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_parcial" })
    const noteId = (await one<{ id: string }>(db,
      "insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,external_amount,settlement_status) values(1,$1,'processing','external_refund',2000,2000,'pendiente') returning id", [id])).id
    await db.query("insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,1,1,2000,2000)", [noteId])
    // En proceso: el importe todavía se corrige con los flujos normales.
    await db.query("update order_credit_notes set total_amount=1800, external_amount=1800 where id=$1", [noteId])
    await assert.rejects(db.query(
      "update order_credit_notes set status='authorized', cae='CAE-1', voucher_point=1, voucher_number=77, authorized_at=now(), total_amount=900, external_amount=900 where id=$1",
      [noteId]), NOTE_IMMUTABLE)
    await db.query("update order_credit_notes set status='authorized', cae='CAE-1', voucher_point=1, voucher_number=77, authorized_at=now() where id=$1", [noteId])
    assert.equal(Number((await noteOf(db, noteId)).total_amount), 1800)
  } finally {
    await db.close()
  }
})

test("P1-2 liquidaciones normales: comprobante, Mercado Pago, referencia, estado y reintento idempotente", async () => {
  const db = await setup()
  try {
    // Comprobante manual por el importe completo: liquida y cierra.
    const { id, noteId } = await partialRefundClaim(db)
    await db.query("update order_credit_notes set management_status='reembolso_pendiente', updated_at=now() where id=$1", [noteId])
    await refundWithProof(db, [noteId])
    // Reintento idempotente de la misma liquidación.
    await markSettledWithoutEvidence(db, noteId)
    await close(db, id)
    assert.equal(await claimStatus(db, id), "cerrado")
    // Liquidada y finalizada: ni importes ni referencia.
    await assert.rejects(db.query("update order_credit_notes set total_amount=1000 where id=$1", [noteId]), NOTE_IMMUTABLE)

    // Mercado Pago: settlement_status / settlement_reference por la conciliación.
    const other = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
    await mutate(db, other, { status: "reintegro_pendiente", resolution: "reintegro_parcial" })
    const mpNote = await authorizedClaimNote(db, { claimId: other, orderId: 2, destination: "external_refund", lines: [{ orderItemId: 4, quantity: 1 }], amount: 2000, externalAmount: 2000 })
    await db.query("update order_credit_notes set settlement_status='procesando' where id=$1", [mpNote.id])
    await db.query("update order_credit_notes set settlement_status='pendiente', settlement_reference='pendiente-mp' where id=$1", [mpNote.id])
    await refundWithMercadoPago(db, mpNote.id)
    await close(db, other)
    assert.equal(await claimStatus(db, other), "cerrado")
  } finally {
    await db.close()
  }
})

// ---------------------------------------------------------------------------
// Revisión: reaprobación del importe de un cupón antes de emitir la NC
// ---------------------------------------------------------------------------

test("cupón: revisar el importe antes de la NC sigue permitido y queda auditado (anterior, nuevo, Admin, fecha)", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }])
    await mutate(db, id, { status: "aprobado", resolution: "cupon_descuento", credit_note_amount: 5000 })
    await mutate(db, id, { status: "aprobado", resolution: "cupon_descuento", credit_note_amount: 3000, admin_response: "Ajustamos el importe del cupón." })
    assert.equal(Number((await claim(db, id)).approved_amount), 3000)
    const events = (await db.query<Row>(
      "select actor_type, actor_id, metadata, created_at from order_audit_events where action='claim_coupon_amount_approved' and (metadata->>'claimId')::bigint=$1 order by id", [id])).rows
    assert.equal(events.length, 2)
    assert.deepEqual(events.map((event) => [(event.metadata as Row).previousAmount, (event.metadata as Row).newAmount]), [[null, 5000], [5000, 3000]])
    assert.ok(events.every((event) => event.actor_type === "admin" && event.actor_id === admin && event.created_at))
    assert.equal((events[1].metadata as Row).message, "Ajustamos el importe del cupón.")
    // Con la NC emitida, el importe ya no cambia (la RPC lo impide).
    await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 1 }], amount: 3000 })
    await assert.rejects(mutate(db, id, { status: "aprobado", resolution: "cupon_descuento", credit_note_amount: 1000 }), /CLAIM_INVALID_AMOUNT/)
  } finally {
    await db.close()
  }
})
