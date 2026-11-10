// Evidencia financiera de una NC de reclamo, reproducida tal como la persisten
// los flujos reales (sólo para fixtures aisladas de tests):
//   * saldo a favor: creditCustomerForOrderCreditNote (lib/customer-credit/server.ts)
//     + finalizeCreditNote marca la NC 'completado';
//   * reintegro manual: complete_manual_order_financial_refund (comprobante en
//     order_refund_proofs y settlement_reference = id del comprobante);
//   * reintegro Mercado Pago: refund 'confirmed' + settle_credit_notes_after_mercadopago_refund
//     (settlement_reference = 'mp_refund:<ids>').

export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

/** Tabla real mínima (20260911170000) para los entornos que no la crean. */
export const MERCADOPAGO_REFUNDS_TABLE_SQL =
  "create table if not exists mercadopago_order_refunds(id uuid primary key default gen_random_uuid(), order_id bigint not null, payment_id text not null, " +
  "amount numeric(12,2) not null check (amount > 0), status text not null default 'processing', mp_refund_id text, completed_at timestamptz)"

export type NoteDestination = "external_refund" | "customer_balance"

export interface NoteLine {
  orderItemId: number
  quantity: number
}

let nextVoucher = 1000

export const voucherLabel = (point: number, number: number) =>
  `${String(point).padStart(4, "0")}-${String(number).padStart(8, "0")}`

/** NC de reclamo: processing con renglones y luego autorizada por ARCA (CAE + comprobante). */
export async function authorizedClaimNote(db: SqlClient, {
  claimId,
  orderId = 1,
  destination,
  lines,
  amount = 1000,
  externalAmount = null,
  customerCreditAmount = 0,
}: {
  /** null = NC del pedido, sin reclamo. */
  claimId: number | null
  orderId?: number
  destination: NoteDestination
  lines: NoteLine[]
  amount?: number
  externalAmount?: number | null
  customerCreditAmount?: number
}) {
  nextVoucher += 1
  const voucherNumber = nextVoucher
  // Encabezado + renglones en una transacción, como el flujo real (la NC de un
  // mixto exige renglones al confirmar: zz_guard_mixed_claim_credit_note_has_items).
  await db.query("begin")
  try {
    const id = await insertProcessingNote(db, { claimId, orderId, destination, lines, amount, externalAmount, customerCreditAmount })
    await db.query(
      "update order_credit_notes set status='authorized', cae=$2, voucher_point=1, voucher_number=$3, authorized_at=now() where id=$1",
      [id, `CAE-${voucherNumber}`, voucherNumber])
    await db.query("commit")
    return { id, voucherNumber }
  } catch (error) {
    await db.query("rollback")
    throw error
  }
}

async function insertProcessingNote(db: SqlClient, { claimId, orderId, destination, lines, amount, externalAmount, customerCreditAmount }: {
  claimId: number | null; orderId: number; destination: NoteDestination; lines: NoteLine[]; amount: number; externalAmount: number | null; customerCreditAmount: number
}) {
  const note = (await db.query<{ id: string }>(
    "insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,external_amount,customer_credit_amount,settlement_status) " +
    "values($1,$2,'processing',$3,$4,$5,$6,'pendiente') returning id",
    [orderId, claimId, destination, amount, externalAmount, customerCreditAmount])).rows[0]
  for (const line of lines) {
    await db.query("insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,$2,$3,$4,$5)",
      [note.id, line.orderItemId, line.quantity, amount / Math.max(1, line.quantity), amount])
  }
  return note.id
}

const noteRow = async (db: SqlClient, noteId: string) => (await db.query<{
  order_id: number; claim_id: number | null; voucher_number: number; cae: string; total_amount: string; external_amount: string | null; customer_credit_amount: string
}>("select order_id, claim_id, voucher_number, cae, total_amount, external_amount, customer_credit_amount from order_credit_notes where id=$1", [noteId])).rows[0]

const noteMoney = (note: { total_amount: string; external_amount: string | null }) => Number(note.external_amount ?? note.total_amount)

/** Sólo el estado: lo que un UPDATE directo podría fabricar sin dinero. */
export const markSettledWithoutEvidence = (db: SqlClient, noteId: string, reference: string | null = null) =>
  db.query("update order_credit_notes set settlement_status='completado', management_status='finalizada', settlement_date=current_date, settlement_reference=coalesce($2, settlement_reference) where id=$1",
    [noteId, reference])

/**
 * Saldo a favor acreditado en el ledger como creditCustomerForOrderCreditNote
 * (UUID de la NC en metadata). Overrides = movimientos inválidos para tests
 * adversariales; noteUuid null = crédito histórico sin UUID.
 */
export async function creditNoteToBalance(db: SqlClient, noteId: string, overrides: {
  userId?: string; orderId?: number; claimId?: number | null; amount?: number; voucher?: string; sourceKey?: string
  noteUuid?: string | null; cae?: string; settle?: boolean
} = {}) {
  const note = await noteRow(db, noteId)
  const user = (await db.query<{ usuario_id: string }>("select usuario_id from ordenes where id=$1", [note.order_id])).rows[0].usuario_id
  const uuid = overrides.noteUuid === undefined ? noteId : overrides.noteUuid
  const metadata: Record<string, unknown> = { created_from: "arca_credit_note", credit_note_cae: overrides.cae ?? note.cae }
  if (uuid !== null) metadata.order_credit_note_id = uuid
  const movement = (await db.query<{ id: string }>(
    "insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,claim_id,credit_note_id,metadata,source_key) " +
    "values($1,'credit',$2,'credit_note',$3,$4,$5,$6,$7) returning id",
    [overrides.userId ?? user, overrides.amount ?? noteMoney(note), overrides.orderId ?? note.order_id,
      overrides.claimId === undefined ? note.claim_id : overrides.claimId,
      overrides.voucher ?? voucherLabel(1, Number(note.voucher_number)), JSON.stringify(metadata),
      overrides.sourceKey ?? `credit-note:${note.order_id}:1:${note.voucher_number}:${uuid ?? "sin-uuid"}`])).rows[0]
  if (overrides.settle !== false) await markSettledWithoutEvidence(db, noteId)
  return movement.id
}

/** Parte de la compra pagada con saldo: restituida por restore_customer_credit_after_credit_note. */
export async function restoreNoteCustomerCredit(db: SqlClient, noteId: string, amount?: number) {
  const note = await noteRow(db, noteId)
  const user = (await db.query<{ usuario_id: string }>("select usuario_id from ordenes where id=$1", [note.order_id])).rows[0].usuario_id
  return (await db.query<{ id: string }>(
    "insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,metadata,source_key) values($1,'reversal',$2,'reversal',$3,$4,$5) returning id",
    [user, amount ?? Number(note.customer_credit_amount), note.order_id, JSON.stringify({ order_credit_note_id: noteId }),
      `credit-note:${noteId}:customer-credit-restoration`])).rows[0].id
}

/** Comprobante del pago saliente (complete_manual_order_financial_refund). */
export const insertRefundProof = async (db: SqlClient, orderId: number, amount: number) => Number((await db.query<{ id: number }>(
  "insert into order_refund_proofs(order_id,file_name,file_path,mime_type,file_size,amount,method) values($1,'comprobante.pdf','payment-proofs/x/comprobante.pdf','application/pdf',100,$2,'Reintegro manual') returning id",
  [orderId, amount])).rows[0].id)

/** Reintegro manual: un comprobante (por el dinero de todas las NC, salvo override) que liquida esas NC. */
export async function refundWithProof(db: SqlClient, noteIds: string[], overrides: { amount?: number; orderId?: number; proofId?: number } = {}) {
  const first = await noteRow(db, noteIds[0])
  let total = 0
  for (const id of noteIds) total += noteMoney(await noteRow(db, id))
  const proofId = overrides.proofId ?? await insertRefundProof(db, overrides.orderId ?? first.order_id, overrides.amount ?? total)
  for (const id of noteIds) await markSettledWithoutEvidence(db, id, String(proofId))
  return proofId
}

/** Refund Mercado Pago (por defecto confirmado y del pago original del pedido). */
export async function insertMercadoPagoRefund(db: SqlClient, { orderId, amount, status = "confirmed", paymentId, mpRefundId }: {
  orderId: number; amount: number; status?: string; paymentId?: string | null; mpRefundId?: string | null
}) {
  const payment = paymentId === undefined
    ? (await db.query<{ payment_id: string | null }>("select payment_id from ordenes where id=$1", [orderId])).rows[0].payment_id
    : paymentId
  return (await db.query<{ id: string }>(
    "insert into mercadopago_order_refunds(order_id,payment_id,amount,status,mp_refund_id,completed_at) values($1,$2,$3,$4,$5,case when $4='confirmed' then now() end) returning id",
    [orderId, payment, amount, status, mpRefundId === undefined ? `mp-${Math.floor(Math.random() * 1e9)}` : mpRefundId])).rows[0].id
}

/** settle_credit_notes_after_mercadopago_refund: refund confirmado + NC liquidada con referencia 'mp_refund:'. */
export async function refundWithMercadoPago(db: SqlClient, noteId: string, overrides: {
  amount?: number; orderId?: number; paymentId?: string | null; reference?: string; status?: string
} = {}) {
  const note = await noteRow(db, noteId)
  const refundId = await insertMercadoPagoRefund(db, {
    orderId: overrides.orderId ?? note.order_id, amount: overrides.amount ?? noteMoney(note), status: overrides.status, paymentId: overrides.paymentId,
  })
  const mpId = (await db.query<{ mp_refund_id: string }>("select mp_refund_id from mercadopago_order_refunds where id=$1", [refundId])).rows[0].mp_refund_id
  await markSettledWithoutEvidence(db, noteId, overrides.reference ?? `mp_refund:${mpId}`)
  return refundId
}
