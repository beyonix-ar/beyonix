import assert from "node:assert/strict"
import test from "node:test"
import {
  authorizedClaimNote,
  creditNoteToBalance,
  refundWithProof,
} from "./fixtures/claim-compensation-evidence.ts"
import {
  LOCKED,
  UNRESOLVED,
  claimStatus,
  close,
  compensate,
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

// Invariantes de la evidencia de un reclamo (reproducciones de la auditoría):
//   P1-1 renglones de NC: nunca se agregan, cambian ni borran en una NC ya
//        autorizada o liquidada (subirían las unidades "compensadas" sin dinero);
//   P1-2 una reversión de saldo nunca se re-vincula a un crédito que respalda
//        un reclamo finalizado (INSERT, UPDATE o DELETE);
//   P1-3 reintegro total / saldo a favor cierran sólo con TODAS las unidades
//        reclamadas cubiertas por NC con dinero probado.
// Cadena REAL de migraciones (PGlite) y fixtures aisladas.

const ITEMS_LOCKED = /CREDIT_NOTE_ITEMS_LOCKED/
const ITEM_INVALID = /CREDIT_NOTE_ITEM_INVALID/
const ITEM_EXCEEDED = /CREDIT_NOTE_ITEM_QUANTITY_EXCEEDED/

const addItem = (db: Db, noteId: string, orderItemId: number, quantity: number) =>
  db.query("insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,$2,$3,1000,$4)",
    [noteId, orderItemId, quantity, 1000 * quantity])
const processingNote = async (db: Db, claimId: number | null, destination = "external_refund", orderId = 1) =>
  (await one<{ id: string }>(db,
    "insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,settlement_status) values($1,$2,'processing',$3,1000,'pendiente') returning id",
    [orderId, claimId, destination])).id
const markRefunded = (db: Db, orderId = 1) => db.query("update ordenes set financial_status='refunded' where id=$1", [orderId])

// ---------------------------------------------------------------------------
// P1-1 Renglones de NC
// ---------------------------------------------------------------------------

test("P1-1 reproducción: un renglón agregado o agrandado en una NC liquidada no cubre unidades sin dinero", async () => {
  const db = await setup()
  try {
    // Pérdida de dos productos distintos (ítems 1 y 3); el dinero real cubre sólo el ítem 1.
    const id = await lossClaim(db, {
      kind: "external_refund",
      items: [{ order_item_id: 1, quantity: 1 }, { order_item_id: 3, quantity: 1 }],
      lost: [{ order_item_id: 1, quantity: 1 }, { order_item_id: 3, quantity: 1 }],
    })
    const note = await compensate(db, id, "external_refund", 1, 1)
    await assert.rejects(addItem(db, note, 3, 1), ITEMS_LOCKED, "INSERT en NC liquidada")
    await assert.rejects(db.query("update order_credit_note_items set quantity=2 where credit_note_id=$1", [note]), ITEMS_LOCKED, "UPDATE de cantidad")
    await assert.rejects(db.query("update order_credit_note_items set order_item_id=3 where credit_note_id=$1", [note]), ITEMS_LOCKED, "cambio de producto")
    await assert.rejects(db.query("delete from order_credit_note_items where credit_note_id=$1", [note]), ITEMS_LOCKED, "DELETE")
    await assert.rejects(close(db, id), UNRESOLVED, "el ítem 3 sigue sin compensar")
    await compensate(db, id, "external_refund", 3, 1)
    await close(db, id)
    await assert.rejects(addItem(db, note, 3, 1), /CREDIT_NOTE_ITEMS_LOCKED|CLAIM_COMPENSATION_EVIDENCE_LOCKED/, "INSERT después del cierre")
  } finally {
    await db.close()
  }
})

test("P1-1 NC en proceso: renglón válido y reintento sin duplicado; producto ajeno o cantidad no autorizada, rechazados", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 2 }])
    await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    const note = await processingNote(db, id)
    await addItem(db, note, 1, 1)
    await assert.rejects(addItem(db, note, 1, 1), /duplicate key|unique/i, "reintento: el mismo renglón no se duplica")
    await assert.rejects(addItem(db, note, 4, 1), ITEM_INVALID, "producto de otro pedido")
    await assert.rejects(addItem(db, note, 3, 1), ITEM_INVALID, "producto del pedido fuera del reclamo")
    await db.query("update order_credit_note_items set quantity=2 where credit_note_id=$1", [note])
    await assert.rejects(db.query("update order_credit_note_items set quantity=3 where credit_note_id=$1", [note]), ITEM_EXCEEDED, "más que lo reclamado")
    // Otra NC del mismo reclamo no suma por encima de lo reclamado.
    await db.query("update order_credit_notes set status='error' where id=$1", [note])
    const second = await processingNote(db, id)
    await addItem(db, second, 1, 2)
    await assert.rejects(db.query("update order_credit_notes set status='processing' where id=$1", [note]),
      ITEM_EXCEEDED, "reactivada, dos NC vigentes nunca cubren más que lo reclamado")
    // NC sin reclamo: sólo productos de su pedido.
    const orderNote = await processingNote(db, null, "external_refund", 2)
    await addItem(db, orderNote, 4, 1)
    await assert.rejects(addItem(db, orderNote, 1, 1), ITEM_INVALID)
  } finally {
    await db.close()
  }
})

// ---------------------------------------------------------------------------
// P1-2 Reversiones vinculadas
// ---------------------------------------------------------------------------

test("P1-2 reproducción: re-vincular un débito existente al crédito de un reclamo finalizado se rechaza", async () => {
  const db = await setup()
  try {
    const closedClaim = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }])
    await mutate(db, closedClaim, { status: "aprobado", resolution: "saldo_a_favor" })
    const protectedNote = await authorizedClaimNote(db, { claimId: closedClaim, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 1 }] })
    const protectedCredit = await creditNoteToBalance(db, protectedNote.id)
    await mutate(db, closedClaim, { action: "mark_credit_note_issued" })
    assert.equal(await claimStatus(db, closedClaim), "cerrado")

    // Reclamo abierto del pedido 2 con su propio crédito (B).
    const openClaim = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
    await mutate(db, openClaim, { status: "aprobado", resolution: "saldo_a_favor" })
    const openNote = await authorizedClaimNote(db, { claimId: openClaim, orderId: 2, destination: "customer_balance", lines: [{ orderItemId: 4, quantity: 1 }] })
    const openCredit = await creditNoteToBalance(db, openNote.id)

    // Ajuste administrativo legítimo, no vinculado: se registra y se corrige con normalidad.
    const adjustment = (await one<{ id: string }>(db,
      "insert into customer_credit_movements(user_id,movement_type,amount,source_type,source_key) values($1,'debit',100,'admin_adjustment','ajuste-1') returning id", [customer])).id
    await db.query("update customer_credit_movements set amount=150 where id=$1", [adjustment])

    await assert.rejects(db.query("insert into customer_credit_movements(user_id,movement_type,amount,source_type,related_movement_id,source_key) values($1,'debit',1000,'reversal',$2,'rev-nueva')",
      [customer, protectedCredit]), LOCKED, "INSERT de reversión posterior al cierre")
    await assert.rejects(db.query("update customer_credit_movements set related_movement_id=$2 where id=$1", [adjustment, protectedCredit]), LOCKED,
      "UPDATE de un débito existente hacia el crédito protegido")
    await assert.rejects(db.query("update customer_credit_movements set movement_type='debit', related_movement_id=$2 where id=$1", [adjustment, protectedCredit]), LOCKED)

    // Reversión antes del cierre (crédito B, reclamo abierto): legítima, corregible y bloquea el cierre de B.
    const reversal = (await one<{ id: string }>(db,
      "insert into customer_credit_movements(user_id,movement_type,amount,source_type,related_movement_id,source_key) values($1,'debit',1000,'reversal',$2,'rev-b') returning id",
      [customer, openCredit])).id
    await assert.rejects(mutate(db, openClaim, { action: "mark_credit_note_issued" }), /CLAIM_CREDIT_PENDING/)
    await db.query("update customer_credit_movements set amount=900 where id=$1", [reversal])
    await assert.rejects(db.query("update customer_credit_movements set related_movement_id=$2 where id=$1", [reversal, protectedCredit]), LOCKED,
      "cambio de la reversión de B hacia el crédito protegido A")
    await db.query("delete from customer_credit_movements where id=$1", [reversal])
    await mutate(db, openClaim, { action: "mark_credit_note_issued" })

    // Con ambos cerrados, tampoco se mueve una reversión entre sus créditos ni se borra su evidencia.
    await assert.rejects(db.query("update customer_credit_movements set related_movement_id=$2 where id=$1", [adjustment, openCredit]), LOCKED)
    assert.equal((await one<{ n: number }>(db, "select count(*)::int n from customer_credit_movements where related_movement_id in ($1,$2)", [protectedCredit, openCredit])).n, 0)
    for (const claimId of [closedClaim, openClaim]) assert.equal(await claimStatus(db, claimId), "cerrado")
  } finally {
    await db.close()
  }
})

// ---------------------------------------------------------------------------
// P1-3 Cobertura completa por unidad
// ---------------------------------------------------------------------------

for (const provider of ["andreani", "beyonix"] as const) {
  test(`P1-3 reproducción (${provider}): reintegro total de 2 unidades con dinero de 1 no cierra (UPDATE ni RPC); con 2, sí`, async () => {
    const db = await setup({ provider })
    try {
      const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 2 }])
      await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_total" })
      const first = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] })
      await refundWithProof(db, [first.id])
      await markRefunded(db)
      await assert.rejects(close(db, id), /CLAIM_REFUND_PENDING/, "UPDATE directo")
      await assert.rejects(mutate(db, id, { action: "mark_refund_done" }), /CLAIM_REFUND_PENDING/, "RPC")
      const second = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] })
      await refundWithProof(db, [second.id])
      await mutate(db, id, { action: "mark_refund_done" })
      assert.equal(await claimStatus(db, id), "cerrado")
    } finally {
      await db.close()
    }
  })
}

test("P1-3 saldo a favor de dos productos y dos variantes: cada ítem con sus unidades; evidencia de otro reclamo no cuenta", async () => {
  const db = await setup()
  try {
    const foreign = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
    await mutate(db, foreign, { status: "aprobado", resolution: "saldo_a_favor" })
    await compensate(db, foreign, "customer_balance", 4, 1)

    const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 2 }, { order_item_id: 2, quantity: 1 }, { order_item_id: 3, quantity: 1 }])
    await mutate(db, id, { status: "aprobado", resolution: "saldo_a_favor" })
    await compensate(db, id, "customer_balance", 1, 2)
    await compensate(db, id, "customer_balance", 2, 1)
    await assert.rejects(close(db, id), /CLAIM_CREDIT_PENDING/, "la variante 2 (ítem 3) sigue sin saldo")
    await compensate(db, id, "customer_balance", 3, 1)
    await mutate(db, id, { action: "mark_credit_note_issued" })
    assert.equal(await claimStatus(db, id), "cerrado")
  } finally {
    await db.close()
  }
})

test("P1-3 reintegro parcial (por importe) y mixto reemplazo + reintegro: conservan sus reglas", async () => {
  const db = await setup()
  try {
    // Reintegro parcial: la solución es un importe menor, no todas las unidades.
    const partial = await createClaim(db, 1, [{ order_item_id: 1, quantity: 2 }])
    await mutate(db, partial, { status: "reintegro_pendiente", resolution: "reintegro_parcial" })
    const note = await authorizedClaimNote(db, { claimId: partial, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }], amount: 600 })
    await refundWithProof(db, [note.id])
    await markRefunded(db)
    await mutate(db, partial, { action: "mark_refund_done" })
    assert.equal(await claimStatus(db, partial), "cerrado")
  } finally {
    await db.close()
  }

  const mixed = await setup()
  try {
    // Mixto (Envío BEYONIX): una unidad recibida y reemplazada, otra perdida y reintegrada.
    const id = await lossClaim(mixed, {
      kind: "mixta",
      lines: [{ order_item_id: 1, solution: "replacement", quantity: 1, return_quantity: 1 }, { order_item_id: 1, solution: "refund", quantity: 1, return_quantity: 1 }],
      received: [{ order_item_id: 1, quantity: 1 }],
      lost: [{ order_item_id: 1, quantity: 1 }],
    })
    await replace(mixed, id, 1, 1, 1)
    await deliverManually(mixed, id, 1, 1)
    await assert.rejects(mutate(mixed, id, { status: "cerrado", resolution: "mixta" }), /CLAIM_TRANSIT_LOSS_UNRESOLVED|CLAIM_MIXED_REFUND_PENDING/)
    await compensate(mixed, id, "external_refund", 1, 1)
    await mutate(mixed, id, { status: "cerrado", resolution: "mixta" })
    assert.equal(await claimStatus(mixed, id), "cerrado")
  } finally {
    await mixed.close()
  }
})

// ---------------------------------------------------------------------------
// Auditoría 3: resolución terminal, destino exacto e importe aprobado
// ---------------------------------------------------------------------------

const TERMINAL = /CLAIM_TERMINAL_IMMUTABLE/
const evidenced = async (db: Db, noteId: string) =>
  (await one<{ e: boolean }>(db, "select order_credit_note_money_evidenced($1) e", [noteId])).e

test("P1-1 reproducción: la resolución de un reclamo finalizado no cambia (UPDATE ni RPC) y su evidencia sigue protegida", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }])
    // Abierto: el cambio de resolución sigue sus reglas existentes.
    await mutate(db, id, { status: "en_revision", resolution: "reintegro_total" })
    await mutate(db, id, { status: "aprobado", resolution: "saldo_a_favor" })
    const note = await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 1 }] })
    const credit = await creditNoteToBalance(db, note.id)
    await mutate(db, id, { action: "mark_credit_note_issued" })
    assert.equal(await claimStatus(db, id), "cerrado")

    await assert.rejects(db.query("update order_claims set resolution='otro' where id=$1", [id]), TERMINAL, "UPDATE directo de la resolución")
    await assert.rejects(db.query("update order_claims set status='aprobado' where id=$1", [id]), TERMINAL, "reabrir por UPDATE directo")
    await assert.rejects(db.query("update order_claims set affected_items='[]' where id=$1", [id]), TERMINAL, "cambiar lo reclamado")
    await assert.rejects(mutate(db, id, { status: "cerrado", resolution: "otro" }), /CLAIM_TERMINAL/, "RPC (ya rechazaba un reclamo terminal)")
    // Cambiar la resolución y el dinero en la misma transacción: se rechaza todo.
    await db.query("begin")
    try {
      await assert.rejects(db.query("update order_claims set resolution='otro' where id=$1", [id]), TERMINAL)
    } finally {
      await db.query("rollback")
    }
    await db.query("begin")
    try {
      await assert.rejects(db.query("update customer_credit_movements set amount=1 where id=$1", [credit]), /CLAIM_COMPENSATION_EVIDENCE_LOCKED/)
    } finally {
      await db.query("rollback")
    }
    assert.equal(await evidenced(db, note.id), true, "la evidencia sigue intacta")
    // La actividad sigue operable; lo que ve el cliente del cierre, no (P2 postauditoría).
    await db.query("update order_claims set admin_needs_action=true, last_customer_message_at=now() where id=$1", [id])
    await assert.rejects(db.query("update order_claims set admin_response='Gracias por tu paciencia.' where id=$1", [id]), TERMINAL)
  } finally {
    await db.close()
  }
})

test("P1-1 rechazado, cancelado y mixto cerrado: ni la resolución ni las soluciones por ítem cambian", async () => {
  const db = await setup()
  try {
    const rejected = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }])
    await mutate(db, rejected, { status: "rechazado", resolution: "rechazado", rejection_reason: "No corresponde a una falla." })
    await assert.rejects(db.query("update order_claims set resolution='saldo_a_favor' where id=$1", [rejected]), TERMINAL)

    const cancelled = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
    await mutate(db, cancelled, { status: "aprobado", resolution: "cambio_producto" })
    await db.query("select applied from cancel_order_claim($1,$2,(select updated_at from order_claims where id=$1),'El cliente desistió del reclamo')",
      [cancelled, "21000000-0000-4000-8000-000000000003"])
    assert.equal(await claimStatus(db, cancelled), "cerrado")
    await assert.rejects(db.query("update order_claims set resolution='saldo_a_favor' where id=$1", [cancelled]), TERMINAL)
  } finally {
    await db.close()
  }

  const mixed = await setup({ provider: "andreani" })
  try {
    const id = await createClaim(mixed, 1, [{ order_item_id: 1, quantity: 1 }, { order_item_id: 2, quantity: 1 }])
    await setLines(mixed, id, [
      { order_item_id: 1, solution: "refund", quantity: 1, return_quantity: 0 },
      { order_item_id: 2, solution: "credit", quantity: 1, return_quantity: 0 },
    ])
    await compensate(mixed, id, "customer_balance", 2, 1)
    await compensate(mixed, id, "external_refund", 1, 1)
    await mutate(mixed, id, { status: "cerrado", resolution: "mixta" })
    await assert.rejects(mixed.query("update order_claim_item_resolutions set quantity=quantity where claim_id=$1", [id]), /CLAIM_TERMINAL/)
    await assert.rejects(mixed.query("delete from order_claim_item_resolutions where claim_id=$1", [id]), /CLAIM_TERMINAL/)
    await assert.rejects(mixed.query("insert into order_claim_item_resolutions(claim_id,order_item_id,solution,quantity) values($1,2,'replacement',1)", [id]), /CLAIM_TERMINAL/)
    await assert.rejects(mixed.query("update order_claims set resolution='saldo_a_favor' where id=$1", [id]), TERMINAL)
  } finally {
    await mixed.close()
  }
})

test("P1-2 reproducción: el destino de la compensación es el de la solución (saldo no se cubre con reintegro ni al revés)", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 2 }])
    await mutate(db, id, { status: "aprobado", resolution: "saldo_a_favor" })
    await compensate(db, id, "customer_balance", 1, 1)
    await compensate(db, id, "external_refund", 1, 1)
    await markRefunded(db)
    await assert.rejects(close(db, id), /CLAIM_CREDIT_PENDING/, "UPDATE directo")
    await assert.rejects(mutate(db, id, { action: "mark_credit_note_issued" }), /CLAIM_CREDIT_PENDING/, "RPC")
  } finally {
    await db.close()
  }

  const refund = await setup()
  try {
    const id = await createClaim(refund, 1, [{ order_item_id: 1, quantity: 1 }, { order_item_id: 3, quantity: 1 }])
    await mutate(refund, id, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    await compensate(refund, id, "external_refund", 1, 1)
    await compensate(refund, id, "customer_balance", 3, 1)
    await markRefunded(refund)
    await assert.rejects(mutate(refund, id, { action: "mark_refund_done" }), /CLAIM_REFUND_PENDING/, "variante 2 con saldo no autorizado")
  } finally {
    await refund.close()
  }

  const ok = await setup()
  try {
    const id = await createClaim(ok, 1, [{ order_item_id: 1, quantity: 2 }])
    await mutate(ok, id, { status: "aprobado", resolution: "saldo_a_favor" })
    await compensate(ok, id, "customer_balance", 1, 1)
    await compensate(ok, id, "customer_balance", 1, 1)
    await mutate(ok, id, { action: "mark_credit_note_issued" })
    assert.equal(await claimStatus(ok, id), "cerrado")
  } finally {
    await ok.close()
  }
})

test("P1-3 reproducción: un cupón cierra sólo con el importe aprobado acreditado; el importe aprobado no cambia por fuera", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, 1, [{ order_item_id: 1, quantity: 1 }])
    await mutate(db, id, { status: "aprobado", resolution: "cupon_descuento", credit_note_amount: 2000 })
    const first = await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [], amount: 1000 })
    await creditNoteToBalance(db, first.id)
    await assert.rejects(mutate(db, id, { action: "mark_credit_note_issued" }), /CLAIM_CREDIT_PENDING/, "RPC con 1000 de 2000")
    await assert.rejects(close(db, id), /CLAIM_CREDIT_PENDING/, "UPDATE directo con 1000 de 2000")
    await assert.rejects(db.query("update order_claims set approved_amount=1000 where id=$1", [id]), /CLAIM_APPROVED_AMOUNT_IMMUTABLE/, "reducir el aprobado")
    const second = await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [], amount: 1000 })
    await creditNoteToBalance(db, second.id)
    await mutate(db, id, { action: "mark_credit_note_issued" })
    assert.equal(await claimStatus(db, id), "cerrado")
    await assert.rejects(db.query("update order_claims set approved_amount=1 where id=$1", [id]), /CLAIM_APPROVED_AMOUNT_IMMUTABLE|CLAIM_TERMINAL_IMMUTABLE/)
  } finally {
    await db.close()
  }
})
