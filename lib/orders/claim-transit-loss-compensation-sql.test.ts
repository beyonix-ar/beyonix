import assert from "node:assert/strict"
import test from "node:test"
import {
  authorizedClaimNote,
  creditNoteToBalance,
  insertMercadoPagoRefund,
  markSettledWithoutEvidence,
  refundWithMercadoPago,
  refundWithProof,
  restoreNoteCustomerCredit,
  type NoteDestination,
} from "./fixtures/claim-compensation-evidence.ts"
import {
  ALLOCATED,
  ALLOCATION_INVALID,
  EXHAUSTED,
  LOCKED,
  RESOLUTION,
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
  otherCustomer,
  replace,
  setup,
  type Db,
} from "./fixtures/claim-financial-db.ts"

// Pérdida en traslado del retiro por cadete: el reclamo sólo se finaliza con la
// compensación EJECUTADA de cada unidad, probada con la evidencia financiera
// real (ledger de saldo por UUID de la NC, comprobante o refund MP asignados),
// sin reutilizar una compensación entre unidades, ítems, reclamos o pedidos, y
// con esa evidencia congelada después del cierre. Cadena REAL de migraciones
// (PGlite) y fixtures aisladas: nunca toca dinero, saldo ni datos reales.

// ---------------------------------------------------------------------------
// Evidencia financiera real
// ---------------------------------------------------------------------------

test("pérdida + saldo: NC autorizada y 'completado' sin crédito en el ledger -> no cierra; con el crédito real -> cierra", async () => {
  const db = await setup()
  try {
    const id = await lossClaim(db, { kind: "customer_balance" })
    const note = await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 2 }], amount: 2000 })
    await markSettledWithoutEvidence(db, note.id)
    await assert.rejects(close(db, id), UNRESOLVED, "el estado de la NC no prueba que el saldo se acreditó")
    await creditNoteToBalance(db, note.id, { settle: false })
    await close(db, id)
    assert.equal(await claimStatus(db, id), "cerrado")
  } finally {
    await db.close()
  }
})

test("pérdida + reintegro: sin evidencia no cierra; comprobante inexistente o refund no confirmado no liquidan; comprobante o MP confirmado -> cierra", async () => {
  for (const via of ["proof", "mp"] as const) {
    const db = await setup()
    try {
      const id = await lossClaim(db, { kind: "external_refund" })
      const note = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 2 }], amount: 2000 })
      await markSettledWithoutEvidence(db, note.id)
      await assert.rejects(close(db, id), UNRESOLVED, "sin referencia ni asignación")
      await assert.rejects(markSettledWithoutEvidence(db, note.id, "999999"), ALLOCATION_INVALID, "comprobante inexistente")
      const pending = await insertMercadoPagoRefund(db, { orderId: 1, amount: 2000, status: "processing", mpRefundId: "mp-en-curso" })
      // Refund MP no confirmado: la liquidación no consume dinero (se audita) y no cierra.
      await markSettledWithoutEvidence(db, note.id, "mp_refund:mp-en-curso")
      await assert.rejects(close(db, id), UNRESOLVED, "refund MP no confirmado")
      assert.ok(pending)
      if (via === "proof") await refundWithProof(db, [note.id])
      else await refundWithMercadoPago(db, note.id)
      await close(db, id)
      assert.equal(await claimStatus(db, id), "cerrado")
    } finally {
      await db.close()
    }
  }
})

type Fabricate = (db: Db, noteId: string, foreignClaim: number) => Promise<unknown>
/** [caso, destino, evidencia fabricada, error esperado al registrarla (o null si se registra pero no prueba nada)] */
const FOREIGN_EVIDENCE: Array<[string, NoteDestination, Fabricate, RegExp | null]> = [
  ["crédito a otro cliente", "customer_balance", (db, noteId) => creditNoteToBalance(db, noteId, { userId: otherCustomer }), null],
  ["crédito de otro reclamo", "customer_balance", (db, noteId, foreign) => creditNoteToBalance(db, noteId, { claimId: foreign }), null],
  ["crédito de otro pedido", "customer_balance", (db, noteId) => creditNoteToBalance(db, noteId, { orderId: 2, voucher: "0001-99999999" }), null],
  ["crédito por otro comprobante", "customer_balance", (db, noteId) => creditNoteToBalance(db, noteId, { voucher: "0001-99999998" }), null],
  ["crédito insuficiente", "customer_balance", (db, noteId) => creditNoteToBalance(db, noteId, { amount: 1000 }), null],
  ["crédito sin UUID de la NC", "customer_balance", (db, noteId) => creditNoteToBalance(db, noteId, { noteUuid: null }), null],
  ["crédito con el UUID de otra NC", "customer_balance", async (db, noteId) => {
    const other = (await one<{ id: string }>(db, "insert into order_credit_notes(order_id,claim_id,status,destination,total_amount) values(1,null,'error','customer_balance',2000) returning id")).id
    await creditNoteToBalance(db, noteId, { noteUuid: other })
  }, null],
  ["crédito con CAE de otro ambiente", "customer_balance", (db, noteId) => creditNoteToBalance(db, noteId, { cae: "CAE-HOMOLOGACION" }), null],
  ["crédito duplicado", "customer_balance", async (db, noteId) => {
    await creditNoteToBalance(db, noteId, { amount: 1000 })
    await creditNoteToBalance(db, noteId, { sourceKey: `duplicado:${noteId}` })
  }, /duplicate key|unique/i],
  ["crédito revertido", "customer_balance", async (db, noteId) => {
    const movement = await creditNoteToBalance(db, noteId)
    await db.query("insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,related_movement_id,source_key) values($1,'debit',2000,'reversal',1,$2,$3)",
      [customer, movement, `customer-credit:${movement}:admin-reversal`])
  }, null],
  ["comprobante de otro pedido", "external_refund", (db, noteId) => refundWithProof(db, [noteId], { orderId: 2 }), ALLOCATION_INVALID],
  ["comprobante insuficiente", "external_refund", (db, noteId) => refundWithProof(db, [noteId], { amount: 1000 }), EXHAUSTED],
  ["refund MP de otro pedido", "external_refund", (db, noteId) => refundWithMercadoPago(db, noteId, { orderId: 2 }), null],
  ["refund MP de otro pago", "external_refund", (db, noteId) => refundWithMercadoPago(db, noteId, { paymentId: "pay-otro" }), null],
  ["refund MP pendiente", "external_refund", (db, noteId) => refundWithMercadoPago(db, noteId, { status: "processing" }), null],
  ["refund MP fallido", "external_refund", (db, noteId) => refundWithMercadoPago(db, noteId, { status: "failed" }), null],
  ["refund MP confirmado por menos (parcial)", "external_refund", (db, noteId) => refundWithMercadoPago(db, noteId, { amount: 1500 }), null],
  ["refund MP sin id de Mercado Pago", "external_refund", async (db, noteId) => {
    await insertMercadoPagoRefund(db, { orderId: 1, amount: 2000, mpRefundId: null })
    await markSettledWithoutEvidence(db, noteId, "mp_refund:sin-id")
  }, null],
]

for (const [label, destination, fabricate, rejected] of FOREIGN_EVIDENCE) {
  test(`pérdida: evidencia ajena o inconsistente nunca cierra -> ${label}`, async () => {
    const db = await setup()
    try {
      // Reclamo del mismo cliente en otro pedido (origen de la evidencia "de otro reclamo").
      const foreign = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
      const id = await lossClaim(db, { kind: destination })
      const note = await authorizedClaimNote(db, { claimId: id, destination, lines: [{ orderItemId: 1, quantity: 2 }], amount: 2000 })
      if (rejected) await assert.rejects(fabricate(db, note.id, foreign), rejected, `${label}: la liquidación no se registra`)
      else await fabricate(db, note.id, foreign)
      await assert.rejects(close(db, id), UNRESOLVED, label)
      assert.equal(await claimStatus(db, id), RESOLUTION[destination].status)
    } finally {
      await db.close()
    }
  })
}

test("pérdida: parte pagada con saldo sin su restitución en el ledger no cierra; con restitución + crédito del resto, cierra", async () => {
  const db = await setup()
  try {
    const id = await lossClaim(db, { kind: "customer_balance" })
    const note = await authorizedClaimNote(db, {
      claimId: id, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 2 }], amount: 2000, externalAmount: 1400, customerCreditAmount: 600,
    })
    await creditNoteToBalance(db, note.id)
    await assert.rejects(close(db, id), UNRESOLVED, "falta restituir el saldo usado en la compra")
    await restoreNoteCustomerCredit(db, note.id, 300)
    await assert.rejects(close(db, id), UNRESOLVED, "restitución por un importe distinto")
    await db.query("delete from customer_credit_movements where source_key=$1", [`credit-note:${note.id}:customer-credit-restoration`])
    await restoreNoteCustomerCredit(db, note.id)
    await close(db, id)
    assert.equal(await claimStatus(db, id), "cerrado")
  } finally {
    await db.close()
  }
})

test("pérdida: liquidación parcial (dos NC 'completado', sólo una con dinero) y refund MP ya consumido por otra NC -> no cierra", async () => {
  const db = await setup()
  try {
    const id = await lossClaim(db, { kind: "customer_balance" })
    await compensate(db, id, "customer_balance", 1, 1)
    const second = await authorizedClaimNote(db, { claimId: id, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 1 }] })
    await markSettledWithoutEvidence(db, second.id)
    await assert.rejects(close(db, id), UNRESOLVED)
    await creditNoteToBalance(db, second.id, { settle: false })
    await close(db, id)
  } finally {
    await db.close()
  }

  const mp = await setup()
  try {
    const id = await lossClaim(mp, { kind: "external_refund" })
    const a = await authorizedClaimNote(mp, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] })
    const b = await authorizedClaimNote(mp, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] })
    await refundWithMercadoPago(mp, a.id)
    // La misma referencia MP (1000, ya asignados a A) sobre la otra NC: no hay dinero libre, no se asigna.
    const reference = (await one<{ r: string }>(mp, "select settlement_reference r from order_credit_notes where id=$1", [a.id])).r
    await markSettledWithoutEvidence(mp, b.id, reference)
    assert.equal((await one<{ n: number }>(mp, "select count(*)::int n from order_credit_note_refund_allocations where credit_note_id=$1", [b.id])).n, 0)
    await assert.rejects(close(mp, id), UNRESOLVED)
  } finally {
    await mp.close()
  }
})

// ---------------------------------------------------------------------------
// Asignación determinística por unidad, sin reutilizar compensaciones
// ---------------------------------------------------------------------------

test("pérdida: dos unidades iguales, una recibida y otra perdida; compensar sólo una no cubre la perdida", async () => {
  for (const destination of ["external_refund", "customer_balance"] as const) {
    const db = await setup()
    try {
      const id = await lossClaim(db, { kind: destination, received: [{ order_item_id: 1, quantity: 1 }], lost: [{ order_item_id: 1, quantity: 1 }] })
      await compensate(db, id, destination, 1, 1)
      await assert.rejects(close(db, id), UNRESOLVED, `${destination}: la compensación de la recibida no cubre la perdida`)
      await compensate(db, id, destination, 1, 1)
      await close(db, id)
      assert.equal(await claimStatus(db, id), "cerrado")
    } finally {
      await db.close()
    }
  }
})

test("pérdida: dos perdidas; compensar una no alcanza; compensar ambas (MP + comprobante) cierra", async () => {
  const db = await setup()
  try {
    const id = await lossClaim(db, { kind: "external_refund" })
    await compensate(db, id, "external_refund", 1, 1, "mp")
    await assert.rejects(close(db, id), UNRESOLVED)
    await compensate(db, id, "external_refund", 1, 1)
    await close(db, id)
  } finally {
    await db.close()
  }
})

test("pérdida: variantes distintas del mismo producto; la compensación de una variante no cubre la otra", async () => {
  const db = await setup()
  try {
    const id = await lossClaim(db, {
      kind: "customer_balance",
      items: [{ order_item_id: 1, quantity: 1 }, { order_item_id: 3, quantity: 1 }],
      received: [{ order_item_id: 3, quantity: 1 }],
      lost: [{ order_item_id: 1, quantity: 1 }],
    })
    await compensate(db, id, "customer_balance", 3, 1)
    await assert.rejects(close(db, id), UNRESOLVED, "variante 2 compensada, variante 1 perdida sin compensar")
    await compensate(db, id, "customer_balance", 1, 1)
    await close(db, id)
  } finally {
    await db.close()
  }
})

test("pérdida + reemplazo: reservado no cuenta; entregado para la recibida no cubre la perdida", async () => {
  const db = await setup()
  try {
    const id = await lossClaim(db, { kind: "replacement", received: [{ order_item_id: 1, quantity: 1 }], lost: [{ order_item_id: 1, quantity: 1 }] })
    await replace(db, id, 1, 1, 1)
    await assert.rejects(close(db, id), /CLAIM_TRANSIT_LOSS_UNRESOLVED|CLAIM_LOGISTICS_OPEN/, "reserva, no entrega")
    await deliverManually(db, id, 1, 1)
    await assert.rejects(close(db, id), UNRESOLVED, "un reemplazo entregado cubre una sola unidad")
    await replace(db, id, 1, 1, 1)
    await deliverManually(db, id, 1, 1)
    await close(db, id)
  } finally {
    await db.close()
  }
})

test("pérdida + mixto: reemplazo entregado para una unidad + reintegro para la otra; cada solución sólo hasta lo asignado", async () => {
  const db = await setup()
  try {
    const id = await lossClaim(db, {
      kind: "mixta",
      lines: [{ order_item_id: 1, solution: "replacement", quantity: 1, return_quantity: 1 }, { order_item_id: 1, solution: "refund", quantity: 1, return_quantity: 1 }],
      received: [{ order_item_id: 1, quantity: 1 }],
      lost: [{ order_item_id: 1, quantity: 1 }],
    })
    await replace(db, id, 1, 1, 1)
    await deliverManually(db, id, 1, 1)
    await assert.rejects(close(db, id), UNRESOLVED, "falta el reintegro de la otra unidad")
    // Una NC por más de lo asignado al reintegro no se emite (guarda del mixto).
    await assert.rejects(authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 2 }] }), /INVALID_CREDIT_NOTE_CLAIM_ITEM/)
    await compensate(db, id, "external_refund", 1, 1)
    await close(db, id)
    assert.equal(await claimStatus(db, id), "cerrado")
  } finally {
    await db.close()
  }
})

test("pérdida: un comprobante no liquida dos NC por encima de su importe; NC de otro reclamo o del pedido nunca se reasignan", async () => {
  const db = await setup()
  try {
    const id = await lossClaim(db, { kind: "external_refund" })
    const a = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] })
    const b = await authorizedClaimNote(db, { claimId: id, destination: "external_refund", lines: [{ orderItemId: 1, quantity: 1 }] })
    await assert.rejects(refundWithProof(db, [a.id, b.id], { amount: 1000 }), EXHAUSTED, "un comprobante de 1000 no liquida dos NC de 1000")
    await assert.rejects(close(db, id), UNRESOLVED)

    // NC (con dinero real) de un reclamo de otro pedido: nunca cuenta, y no se reasigna.
    const foreign = await createClaim(db, 2, [{ order_item_id: 4, quantity: 1 }])
    await mutate(db, foreign, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    const foreignNote = await compensate(db, foreign, "external_refund", 4, 1)
    await assert.rejects(db.query("update order_credit_notes set claim_id=$2 where id=$1", [foreignNote, id]), /CREDIT_NOTE_CLAIM_IMMUTABLE|CREDIT_NOTE_AUTHORIZED_IMMUTABLE/)
    // NC del pedido sin reclamo: tampoco se asigna a posteriori al reclamo.
    const orderNote = (await one<{ id: string }>(db,
      "insert into order_credit_notes(order_id,claim_id,status,destination,cae,total_amount,settlement_status,voucher_point,voucher_number) values(1,null,'authorized','external_refund','CAE-X',2000,'pendiente',1,555) returning id")).id
    await assert.rejects(db.query("update order_credit_notes set claim_id=$2 where id=$1", [orderNote, id]), /CREDIT_NOTE_CLAIM_IMMUTABLE|CREDIT_NOTE_AUTHORIZED_IMMUTABLE/)
    await assert.rejects(close(db, id), UNRESOLVED)
  } finally {
    await db.close()
  }
})

// ---------------------------------------------------------------------------
// Integridad posterior al cierre
// ---------------------------------------------------------------------------

test("pérdida cerrada: la evidencia de la compensación no se reduce, mueve, borra ni revierte", async () => {
  const db = await setup()
  try {
    const balanceClaim = await lossClaim(db, { kind: "customer_balance" })
    const balanceNote = await authorizedClaimNote(db, { claimId: balanceClaim, destination: "customer_balance", lines: [{ orderItemId: 1, quantity: 2 }], amount: 2000 })
    const movement = await creditNoteToBalance(db, balanceNote.id)
    await close(db, balanceClaim)

    await assert.rejects(db.query("update order_credit_note_items set quantity=1 where credit_note_id=$1", [balanceNote.id]), LOCKED, "reducir cantidad")
    await assert.rejects(db.query("update order_credit_note_items set order_item_id=3 where credit_note_id=$1", [balanceNote.id]), LOCKED, "cambiar el ítem")
    await assert.rejects(db.query("delete from order_credit_note_items where credit_note_id=$1", [balanceNote.id]), LOCKED, "borrar el renglón")
    await assert.rejects(db.query("update order_credit_notes set settlement_status='pendiente' where id=$1", [balanceNote.id]), LOCKED, "deshacer la liquidación")
    // Importe y borrado: además, una NC autorizada nunca cambia su importe ni se borra (guarda previa).
    await assert.rejects(db.query("update order_credit_notes set external_amount=1 where id=$1", [balanceNote.id]), /CREDIT_NOTE_AUTHORIZED_IMMUTABLE/, "cambiar el importe")
    await assert.rejects(db.query("update order_credit_notes set claim_id=null where id=$1", [balanceNote.id]), /CREDIT_NOTE_AUTHORIZED_IMMUTABLE/, "desvincular del reclamo (NC autorizada)")
    await assert.rejects(db.query("delete from order_credit_notes where id=$1", [balanceNote.id]), /CREDIT_NOTE_AUTHORIZED_IMMUTABLE/, "borrar la NC")
    await assert.rejects(db.query("update customer_credit_movements set amount=1 where id=$1", [movement]), LOCKED, "reducir el crédito")
    await assert.rejects(db.query("update customer_credit_movements set claim_id=null where id=$1", [movement]), LOCKED, "desvincular el crédito")
    await assert.rejects(db.query("update customer_credit_movements set metadata='{}' where id=$1", [movement]), LOCKED, "quitar el UUID de la NC")
    await assert.rejects(db.query("delete from customer_credit_movements where id=$1", [movement]), LOCKED, "borrar el crédito")
    await assert.rejects(db.query(
      "insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,claim_id,related_movement_id,source_key) values($1,'debit',2000,'reversal',1,$2,$3,'reversa')",
      [customer, balanceClaim, movement]), LOCKED, "revertir el crédito")
    // Lo no financiero sigue operable y el saldo del cliente se sigue usando con normalidad.
    await db.query("update order_credit_notes set management_status='finalizada', updated_at=now() where id=$1", [balanceNote.id])
    await db.query("update order_credit_note_items set product_name='Auricular (reetiquetado)' where credit_note_id=$1", [balanceNote.id])
    await db.query("insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,source_key) values($1,'debit',500,'order',2,'order:2:credit-use')", [customer])

    const refundClaim = await lossClaim(db, { kind: "external_refund", orderId: 2, items: [{ order_item_id: 4, quantity: 2 }], lost: [{ order_item_id: 4, quantity: 2 }] })
    const proofNote = await authorizedClaimNote(db, { claimId: refundClaim, orderId: 2, destination: "external_refund", lines: [{ orderItemId: 4, quantity: 1 }] })
    const proof = await refundWithProof(db, [proofNote.id])
    const mpNote = await authorizedClaimNote(db, { claimId: refundClaim, orderId: 2, destination: "external_refund", lines: [{ orderItemId: 4, quantity: 1 }] })
    const refund = await refundWithMercadoPago(db, mpNote.id)
    await close(db, refundClaim)
    await assert.rejects(db.query("update order_refund_proofs set amount=1 where id=$1", [proof]), ALLOCATED, "reducir el comprobante")
    await assert.rejects(db.query("update order_refund_proofs set order_id=1 where id=$1", [proof]), ALLOCATED, "mover el comprobante")
    await assert.rejects(db.query("delete from order_refund_proofs where id=$1", [proof]), ALLOCATED, "borrar el comprobante")
    await assert.rejects(db.query("update order_credit_notes set settlement_reference='999' where id=$1", [proofNote.id]), LOCKED, "cambiar la referencia")
    await assert.rejects(db.query("update mercadopago_order_refunds set status='failed' where id=$1", [refund]), ALLOCATED, "revertir el refund MP")
    await assert.rejects(db.query("update mercadopago_order_refunds set amount=1 where id=$1", [refund]), ALLOCATED, "reducir el refund MP")
    await assert.rejects(db.query("delete from mercadopago_order_refunds where id=$1", [refund]), ALLOCATED, "borrar el refund MP")
    await assert.rejects(db.query("delete from order_credit_note_refund_allocations where credit_note_id=$1", [proofNote.id]), /CREDIT_NOTE_REFUND_ALLOCATION_IMMUTABLE/)
    await db.query("update order_refund_proofs set method='Transferencia bancaria' where id=$1", [proof])

    for (const claimId of [balanceClaim, refundClaim]) assert.equal(await claimStatus(db, claimId), "cerrado")
  } finally {
    await db.close()
  }
})
