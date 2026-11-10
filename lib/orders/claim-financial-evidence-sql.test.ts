import assert from "node:assert/strict"
import test from "node:test"
import {
  authorizedClaimNote,
  creditNoteToBalance,
  insertMercadoPagoRefund,
  insertRefundProof,
  markSettledWithoutEvidence,
  refundWithMercadoPago,
  refundWithProof,
} from "./fixtures/claim-compensation-evidence.ts"
import {
  ALLOCATED,
  EXHAUSTED,
  LOCKED,
  claimStatus,
  close,
  createClaim,
  customer,
  deliverManually,
  lossClaim,
  mutate,
  one,
  replace,
  setLines,
  setup,
  type Db,
} from "./fixtures/claim-financial-db.ts"

// Evidencia financiera de reclamos SIN pérdida (Andreani y Envío BEYONIX):
//   P1-1 refunds MP asignados inequívocamente (pedido, pago original, id de MP,
//        estado, importe), nunca por suma global ni por ids de un texto;
//   P1-2 capacidad de comprobantes y refunds: el mismo dinero nunca liquida dos NC;
//   P1-3 crédito de saldo ligado al UUID de la NC (nunca al número fiscal solo);
//   P1-4 cierre de mixtos y de reintegro/saldo con el dinero probado, por RPC o
//        por UPDATE directo.
// Cadena REAL de migraciones (PGlite) y fixtures aisladas.

const allocations = async (db: Db, noteId: string) =>
  (await db.query<{ source: string; amount: string }>(
    "select case when refund_proof_id is not null then 'proof' else 'mp' end source, amount::text amount from order_credit_note_refund_allocations where credit_note_id=$1 order by id",
    [noteId])).rows.map((row) => [row.source, Number(row.amount)])
const evidenced = async (db: Db, noteId: string) =>
  (await one<{ e: boolean }>(db, "select order_credit_note_money_evidenced($1) e", [noteId])).e
const markRefunded = (db: Db, orderId = 1) => db.query("update ordenes set financial_status='refunded' where id=$1", [orderId])

/** Reclamo aceptado sin logística (resolución económica). */
async function moneyClaim(db: Db, resolution: string, status: string, items = [{ order_item_id: 1, quantity: 1 }], orderId = 1) {
  const id = await createClaim(db, orderId, items)
  // El cupón se aprueba con su importe (requiresAmountOnApproval): la NC de la prueba es de 1000.
  await mutate(db, id, resolution === "cupon_descuento" ? { status, resolution, credit_note_amount: 1000 } : { status, resolution })
  return id
}

// ---------------------------------------------------------------------------
// P1-1 Mercado Pago: asignación inequívoca
// ---------------------------------------------------------------------------

test("MP: varios refunds del pago original cubren una NC (asignados uno a uno); la referencia truncada o ilegible no se interpreta", async () => {
  const db = await setup()
  try {
    const id = await moneyClaim(db, "reintegro_total", "reintegro_pendiente", [{ order_item_id: 1, quantity: 2 }])
    const note = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 2 }], amount: 2000 })
    await insertMercadoPagoRefund(db, { orderId: 1, amount: 1200 })
    await insertMercadoPagoRefund(db, { orderId: 1, amount: 800 })
    // Ajeno al pago o no confirmado: nunca suma.
    await insertMercadoPagoRefund(db, { orderId: 1, amount: 5000, paymentId: "pay-otro" })
    await insertMercadoPagoRefund(db, { orderId: 1, amount: 5000, status: "needs_reconciliation" })
    await markSettledWithoutEvidence(db, note.id, `mp_refund:${"x".repeat(190)}`)
    assert.deepEqual(await allocations(db, note.id), [["mp", 1200], ["mp", 800]])
    assert.equal(await evidenced(db, note.id), true)
    await markRefunded(db)
    await close(db, id)
    assert.equal(await claimStatus(db, id), "cerrado")
  } finally {
    await db.close()
  }
})

test("MP: un refund ya asignado no liquida otra NC (ni del reclamo ni del pedido)", async () => {
  const db = await setup()
  try {
    const id = await moneyClaim(db, "reintegro_total", "reintegro_pendiente", [{ order_item_id: 1, quantity: 2 }])
    const a = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] })
    const b = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] })
    const refund = await refundWithMercadoPago(db, a.id)
    // La confirmación MP nunca se revierte por esto: no asigna, queda auditado y la NC no prueba dinero.
    await markSettledWithoutEvidence(db, b.id, `mp_refund:${refund}`)
    assert.equal((await one<{ n: number }>(db, "select count(*)::int n from order_audit_events where action='credit_note_refund_allocation_insufficient' and metadata->>'orderCreditNoteId'=$1", [b.id])).n, 1)
    await assert.rejects(db.query("insert into order_credit_note_refund_allocations(credit_note_id,order_id,mercadopago_refund_id,amount) values($1,1,$2,1)", [b.id, refund]),
      EXHAUSTED, "tampoco insertando la asignación a mano")
    assert.equal(await evidenced(db, b.id), false)
  } finally {
    await db.close()
  }
})

// ---------------------------------------------------------------------------
// P1-2 Capacidad de comprobantes manuales
// ---------------------------------------------------------------------------

test("comprobante: NC A ($1.000) cierra su reclamo; una NC B posterior que reutiliza el comprobante se rechaza", async () => {
  const db = await setup()
  try {
    const claimA = await moneyClaim(db, "reintegro_total", "reintegro_pendiente")
    const a = await authorizedClaimNote(db, { claimId: claimA, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] })
    const proof = await refundWithProof(db, [a.id])
    await markRefunded(db)
    await mutate(db, claimA, { action: "mark_refund_done" })
    assert.equal(await claimStatus(db, claimA), "cerrado")

    // NC B posterior del mismo pedido: nunca consume el dinero ya asignado a A.
    const b = await authorizedClaimNote(db, { claimId: null, destination: "external_refund", lines: [{ orderItemId: 3, quantity: 1 }] })
    await assert.rejects(refundWithProof(db, [b.id], { proofId: proof }), EXHAUSTED)
    await assert.rejects(db.query("insert into order_credit_note_refund_allocations(credit_note_id,order_id,refund_proof_id,amount) values($1,1,$2,1000)", [b.id, proof]), EXHAUSTED)
    assert.equal(await evidenced(db, a.id), true, "el respaldo del reclamo A sigue intacto")
    await assert.rejects(db.query("update order_refund_proofs set amount=500 where id=$1", [proof]), ALLOCATED)
  } finally {
    await db.close()
  }
})

test("comprobante con capacidad $2.000: liquida dos NC de $1.000 y ninguna más", async () => {
  const db = await setup()
  try {
    const id = await moneyClaim(db, "reintegro_total", "reintegro_pendiente", [{ order_item_id: 1, quantity: 3 }])
    const notes = []
    for (let index = 0; index < 3; index += 1) {
      notes.push(await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] }))
    }
    const proof = await insertRefundProof(db, 1, 2000)
    await refundWithProof(db, [notes[0].id, notes[1].id], { proofId: proof })
    await assert.rejects(refundWithProof(db, [notes[2].id], { proofId: proof }), EXHAUSTED)
    const used = await one<{ total: string }>(db, "select sum(amount)::text total from order_credit_note_refund_allocations where refund_proof_id=$1", [proof])
    assert.equal(Number(used.total), 2000)
    await assert.rejects(close(db, id), /CLAIM_REFUND_PENDING/, "la tercera NC sigue sin dinero")
  } finally {
    await db.close()
  }
})

test("reintegro parcial legítimo: NC por el importe parcial con su comprobante cierra (RPC); comprobante de otro pedido no", async () => {
  const db = await setup()
  try {
    const id = await moneyClaim(db, "reintegro_parcial", "reintegro_pendiente", [{ order_item_id: 1, quantity: 2 }])
    const note = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }], amount: 600 })
    await assert.rejects(refundWithProof(db, [note.id], { orderId: 2 }), /CREDIT_NOTE_REFUND_ALLOCATION_INVALID/)
    await refundWithProof(db, [note.id])
    await markRefunded(db)
    await mutate(db, id, { action: "mark_refund_done" })
    assert.equal(await claimStatus(db, id), "cerrado")
  } finally {
    await db.close()
  }
})

// ---------------------------------------------------------------------------
// P1-3 Saldo a favor: el crédito pertenece a UNA nota (UUID)
// ---------------------------------------------------------------------------

test("saldo: mismo número fiscal en dos ambientes; cada NC cuenta sólo con SU crédito (UUID); un crédito histórico sin UUID vuelve ambiguas a ambas", async () => {
  const db = await setup()
  try {
    const id = await moneyClaim(db, "saldo_a_favor", "aprobado", [{ order_item_id: 1, quantity: 2 }])
    const a = await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 1 }] })
    const b = await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 1 }] })
    // Homologación y producción numeran igual: mismo punto y número, otro CAE.
    await db.query("update order_credit_notes set voucher_number=$2 where id=$1", [b.id, a.voucherNumber])
    await creditNoteToBalance(db, a.id)
    await markSettledWithoutEvidence(db, b.id)
    assert.equal(await evidenced(db, a.id), true)
    assert.equal(await evidenced(db, b.id), false, "el crédito de A nunca acredita a B")
    await assert.rejects(mutate(db, id, { action: "mark_credit_note_issued" }), /CLAIM_CREDIT_PENDING/, "RPC")
    await assert.rejects(close(db, id), /CLAIM_CREDIT_PENDING/, "UPDATE directo")
    await assert.rejects(creditNoteToBalance(db, b.id, { noteUuid: a.id, sourceKey: "otro" }), /duplicate key|unique/i, "un movimiento no acredita dos notas")
    await creditNoteToBalance(db, b.id, { settle: false })
    assert.equal(await evidenced(db, b.id), true)

    // Crédito histórico sin UUID para ese comprobante: no se atribuye a ninguna.
    await db.query("insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,claim_id,credit_note_id,source_key) values($1,'credit',1000,'credit_note',1,$2,$3,'historico')",
      [customer, id, `0001-${String(a.voucherNumber).padStart(8, "0")}`])
    assert.deepEqual([await evidenced(db, a.id), await evidenced(db, b.id)], [false, false])
    await assert.rejects(close(db, id), /CLAIM_CREDIT_PENDING/)
  } finally {
    await db.close()
  }
})

test("saldo: crédito correcto cierra (RPC); revertido o sin UUID no; después del cierre no se revierte", async () => {
  const db = await setup()
  try {
    const id = await moneyClaim(db, "saldo_a_favor", "aprobado")
    const note = await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 1 }] })
    const legacy = await creditNoteToBalance(db, note.id, { noteUuid: null })
    await assert.rejects(mutate(db, id, { action: "mark_credit_note_issued" }), /CLAIM_CREDIT_PENDING/, "sin UUID")
    await db.query("delete from customer_credit_movements where id=$1", [legacy])
    const movement = await creditNoteToBalance(db, note.id, { settle: false })
    const reversal = (await one<{ id: string }>(db,
      "insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,related_movement_id,source_key) values($1,'debit',1000,'reversal',1,$2,'rev-1') returning id",
      [customer, movement])).id
    await assert.rejects(close(db, id), /CLAIM_CREDIT_PENDING/, "revertido")
    await db.query("delete from customer_credit_movements where id=$1", [reversal])
    await mutate(db, id, { action: "mark_credit_note_issued" })
    assert.equal(await claimStatus(db, id), "cerrado")
    await assert.rejects(db.query("insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,related_movement_id,source_key) values($1,'debit',1000,'reversal',1,$2,'rev-2')",
      [customer, movement]), LOCKED)
    await assert.rejects(db.query("delete from customer_credit_movements where id=$1", [movement]), LOCKED)
  } finally {
    await db.close()
  }
})

// ---------------------------------------------------------------------------
// P1-4 Cierre de mixtos y de reintegro/saldo sin pérdida (Andreani y BEYONIX)
// ---------------------------------------------------------------------------

for (const provider of ["andreani", "beyonix"] as const) {
  test(`${provider} mixto: reintegro + saldo de dos productos; 'completado' sin dinero no cierra por RPC ni por UPDATE; con dinero, sí`, async () => {
    const db = await setup({ provider })
    try {
      const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }, { order_item_id: 2, quantity: 1 }])
      await setLines(db, id, [
        { order_item_id: 1, solution: "refund", quantity: 1, return_quantity: 0 },
        { order_item_id: 2, solution: "credit", quantity: 1, return_quantity: 0 },
      ])
      // El saldo del mixto se emite primero (CLAIM_MIXED_CREDIT_FIRST).
      const credit = await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [{ orderItemId: 2, quantity: 1 }] })
      const refund = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] })
      await markSettledWithoutEvidence(db, credit.id)
      await markSettledWithoutEvidence(db, refund.id)
      await assert.rejects(mutate(db, id, { status: "cerrado", resolution: "mixta" }), /CLAIM_MIXED_REFUND_PENDING/, "RPC")
      await assert.rejects(close(db, id), /CLAIM_MIXED_REFUND_PENDING/, "UPDATE directo")
      await refundWithProof(db, [refund.id])
      await assert.rejects(close(db, id), /CLAIM_MIXED_CREDIT_PENDING/)
      await creditNoteToBalance(db, credit.id, { settle: false })
      await mutate(db, id, { status: "cerrado", resolution: "mixta" })
      assert.equal(await claimStatus(db, id), "cerrado")
      await assert.rejects(db.query("update order_credit_note_items set quantity=2 where credit_note_id=$1", [credit.id]), LOCKED)
    } finally {
      await db.close()
    }
  })

  test(`${provider} reintegro y saldo simples: el cierre exige el dinero probado por RPC y por UPDATE directo`, async () => {
    for (const [resolution, status, destination, action, code] of [
      ["reintegro_total", "reintegro_pendiente", "external_refund", "mark_refund_done", /CLAIM_REFUND_PENDING/],
      ["saldo_a_favor", "aprobado", "customer_balance", "mark_credit_note_issued", /CLAIM_CREDIT_PENDING/],
      ["cupon_descuento", "aprobado", "customer_balance", "mark_credit_note_issued", /CLAIM_CREDIT_PENDING/],
    ] as const) {
      const db = await setup({ provider })
      try {
        const id = await moneyClaim(db, resolution, status)
        await assert.rejects(close(db, id), code, `${resolution}: sin NC`)
        const note = await authorizedClaimNote(db, { claimId: id, destination, lines: [{ orderItemId: 1, quantity: 1 }] })
        await markSettledWithoutEvidence(db, note.id)
        await markRefunded(db)
        await assert.rejects(close(db, id), code, `${resolution}: UPDATE directo sin dinero`)
        if (destination === "external_refund") {
          await db.query("update order_credit_notes set settlement_status='pendiente' where id=$1", [note.id])
          await refundWithProof(db, [note.id])
        } else {
          await creditNoteToBalance(db, note.id, { settle: false })
        }
        await mutate(db, id, { action })
        assert.equal(await claimStatus(db, id), "cerrado", resolution)
      } finally {
        await db.close()
      }
    }
  })
}

test("mixto: dos variantes del mismo producto y reemplazo + saldo; el reemplazo sigue sus reglas y el saldo exige dinero", async () => {
  const db = await setup({ provider: "andreani" })
  try {
    const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }, { order_item_id: 3, quantity: 1 }])
    await setLines(db, id, [
      { order_item_id: 1, solution: "credit", quantity: 1, return_quantity: 0 },
      { order_item_id: 3, solution: "refund", quantity: 1, return_quantity: 0 },
    ])
    const credit = await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 1 }] })
    const refund = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 3, quantity: 1 }] })
    await creditNoteToBalance(db, credit.id)
    // El dinero de la variante 1 no cubre la variante 2.
    await assert.rejects(close(db, id), /CLAIM_MIXED_REFUND_PENDING/)
    await refundWithMercadoPago(db, refund.id)
    await close(db, id)
    assert.equal(await claimStatus(db, id), "cerrado")
  } finally {
    await db.close()
  }

  // Reemplazo + saldo (Envío BEYONIX): la unidad a reemplazar vuelve por cadete; la de saldo queda con el cliente.
  const mixed = await setup()
  try {
    const id = await lossClaim(mixed, {
      kind: "mixta",
      lines: [
        { order_item_id: 1, solution: "replacement", quantity: 1, return_quantity: 1 },
        { order_item_id: 1, solution: "credit", quantity: 1, return_quantity: 0 },
      ],
      received: [{ order_item_id: 1, quantity: 1 }],
      lost: [],
    })
    const credit = await authorizedClaimNote(mixed, { claimId: id, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 1 }] })
    await markSettledWithoutEvidence(mixed, credit.id)
    await assert.rejects(close(mixed, id), /CLAIM_MIXED_REPLACEMENT_PENDING/, "regla de reemplazo intacta")
    await replace(mixed, id, 1, 1, 1)
    await deliverManually(mixed, id, 1, 1)
    await assert.rejects(mutate(mixed, id, { status: "cerrado", resolution: "mixta" }), /CLAIM_MIXED_CREDIT_PENDING/, "saldo marcado sin dinero (RPC)")
    await assert.rejects(close(mixed, id), /CLAIM_MIXED_CREDIT_PENDING/, "saldo marcado sin dinero (UPDATE)")
    await creditNoteToBalance(mixed, credit.id, { settle: false })
    await mutate(mixed, id, { status: "cerrado", resolution: "mixta" })
    assert.equal(await claimStatus(mixed, id), "cerrado")
  } finally {
    await mixed.close()
  }
})

test("compatibilidad: reemplazo simple y cancelación siguen sus reglas", async () => {
  const db = await setup()
  try {
    const id = await moneyClaim(db, "cambio_producto", "aprobado")
    await assert.rejects(mutate(db, id, { status: "cerrado", resolution: "cambio_producto" }), /CLAIM_REPLACEMENT_REQUIRED/)
    const cancelled = await db.query<{ applied: boolean }>("select applied from cancel_order_claim($1,$2,(select updated_at from order_claims where id=$1),'El cliente desistió del reclamo')",
      [id, "21000000-0000-4000-8000-000000000003"])
    assert.equal(cancelled.rows[0].applied, true)
    assert.equal(await claimStatus(db, id), "cerrado")
  } finally {
    await db.close()
  }
})
