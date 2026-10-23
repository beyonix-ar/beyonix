import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { allocateEffectiveOrderItemAmounts } from "./credit-note-calculations.ts"
import { buildLegacyCreditNoteAmounts, buildLegacyCreditNoteItems, getLegacyCreditNoteState } from "./legacy-credit-note.ts"

// Caso real: pedido #2 (13/10/2026) -- cancelado por Admin, reintegrado por
// Mercado Pago antes de la factura 1-8, NC obligatoria nunca emitida.
const legacyOrder = {
  estado: "cancelado",
  financial_status: "refunded",
  credit_note_required: true,
  refunded_at: "2026-10-13T22:42:31.371Z",
  invoice_status: "authorized",
  invoice_cae: "86417596112941",
  invoice_number: 8,
  invoice_point: 1,
  order_credit_notes: [],
}

test("caso heredado: facturado + reintegrado + NC obligatoria pendiente", () => {
  assert.equal(getLegacyCreditNoteState(legacyOrder), "pending")
  assert.equal(getLegacyCreditNoteState({ ...legacyOrder, order_credit_notes: [{ status: "processing" }] }), "processing")
  assert.equal(getLegacyCreditNoteState({ ...legacyOrder, order_credit_notes: [{ status: "authorized" }] }), "none")
  assert.equal(getLegacyCreditNoteState({ ...legacyOrder, order_credit_notes: [{ status: "error" }] }), "pending", "un intento fallido se puede reintentar")
  // No es caso heredado:
  assert.equal(getLegacyCreditNoteState({ ...legacyOrder, financial_status: "refund_pending" }), "none", "reintegro pendiente: lo resuelve el circuito normal")
  assert.equal(getLegacyCreditNoteState({ ...legacyOrder, credit_note_required: false }), "none", "pedido #4: NC ya emitida")
  assert.equal(getLegacyCreditNoteState({ ...legacyOrder, invoice_status: "pending", invoice_cae: null }), "none", "sin factura no hay NC")
  assert.equal(getLegacyCreditNoteState({ ...legacyOrder, refunded_at: null }), "none")
  assert.equal(getLegacyCreditNoteState({ ...legacyOrder, estado: "entregado" }), "none")
})

test("importes: la NC anula exactamente el total facturado", () => {
  assert.deepEqual(buildLegacyCreditNoteAmounts(1000, [1000]), { itemsAmount: 1000, manualAmount: 0, totalAmount: 1000 })
  assert.deepEqual(buildLegacyCreditNoteAmounts(13500, [6000, 6000]), { itemsAmount: 12000, manualAmount: 1500, totalAmount: 13500 }, "envío cobrado como ajuste")
  assert.equal(buildLegacyCreditNoteAmounts(1000, [1200]), null, "nunca supera la factura")
  assert.equal(buildLegacyCreditNoteAmounts(0, []), null)
})

test("detalle moderno y heredado: conserva nombres reales y todos los campos obligatorios", () => {
  const orderItem = { id: 2, producto_id: 1, variante_id: 1, conditioned_name: null, cantidad: 1, precio: 1000 }
  const allocations = allocateEffectiveOrderItemAmounts({ total: 1000, shipping_cost_charged: 0 }, [orderItem])
  const products = new Map([[1, "ENCENDEDOR ELECTRICO CON CARGA USB"]])
  const variants = new Map([[1, "ALEATORIO"]])
  const expected = [{ order_item_id: 2, quantity: 1, unit_amount: 1000, total_amount: 1000,
    product_name: "ENCENDEDOR ELECTRICO CON CARGA USB", variant_name: "ALEATORIO" }]
  assert.deepEqual(buildLegacyCreditNoteItems([orderItem], allocations,
    [{ order_item_id: 2, product_name: expected[0].product_name, variant_name: "ALEATORIO" }], products, variants), { items: expected })
  // BX-1002: el ítem no tiene nombre moderno; el snapshot de la factura sí.
  assert.deepEqual(buildLegacyCreditNoteItems([orderItem], allocations,
    [{ order_item_id: 2, product_name: expected[0].product_name, variant_name: "ALEATORIO" }], new Map(), new Map()), { items: expected })
  assert.deepEqual(buildLegacyCreditNoteItems([orderItem], allocations, [], products, variants), { items: expected },
    "el catálogo real permite recuperar un snapshot ausente")
  assert.deepEqual(buildLegacyCreditNoteItems([{ ...orderItem, conditioned_name: "Equipo reacondicionado" }], allocations, [], new Map(), new Map()),
    { items: [{ ...expected[0], product_name: "Equipo reacondicionado", variant_name: null }] },
    "un nombre histórico del ítem también es recuperable")
  assert.deepEqual(buildLegacyCreditNoteItems([orderItem], allocations,
    [{ order_item_id: 2, product_name: "Producto #1", variant_name: "ALEATORIO" }], products, variants), { items: expected },
  "un marcador fiscal cede ante el catálogo real")
  assert.deepEqual(buildLegacyCreditNoteItems([orderItem], allocations,
    [{ order_item_id: 2, product_name: "Producto #1", variant_name: null }], new Map(), new Map()),
  { error: { code: "ITEM_NAME_MISSING", orderItemId: 2 } }, "un marcador de backfill no es un nombre real")
  assert.deepEqual(buildLegacyCreditNoteItems([orderItem], allocations, [], new Map(), new Map()),
    { error: { code: "ITEM_NAME_MISSING", orderItemId: 2 } })
  assert.deepEqual(buildLegacyCreditNoteItems([{ ...orderItem, cantidad: 0 }], allocations, [], products, variants),
    { error: { code: "ITEM_DATA_INVALID", orderItemId: 2 } }, "no omite líneas inválidas en silencio")
  assert.deepEqual(buildLegacyCreditNoteItems([orderItem, { ...orderItem, id: 3, cantidad: 0 }], allocations, [], products, variants),
    { error: { code: "ITEM_DATA_INVALID", orderItemId: 3 } }, "no omite un segundo ítem inválido")
})

test("SQL real: la NC heredada es sólo fiscal, no mueve dinero y no se emite dos veces", async () => {
  const migration = readFileSync("supabase/migrations/20261014140000_automatic_cancellation_fiscal_refund.sql", "utf8").replace(/\r\n/g, "\n")
  const block = (source: string, start: string) => {
    const from = source.indexOf(start)
    return source.slice(from, source.indexOf("$$;", source.indexOf("as $$", from)) + 3)
  }
  const directCancellation = readFileSync("supabase/migrations/20261023110000_super_admin_cancellation_financial_circuit.sql", "utf8").replace(/\r\n/g, "\n")
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
    await db.exec(`alter table order_credit_notes add column if not exists external_amount numeric(12,2);
      alter table order_credit_notes add column if not exists customer_credit_amount numeric(12,2) not null default 0;
      alter table order_credit_note_items alter column product_name set not null;
      alter table order_credit_note_items alter column quantity set not null;
      alter table order_credit_note_items alter column unit_amount set not null;
      alter table order_credit_note_items alter column total_amount set not null;
      alter table ordenes add column if not exists credit_balance_used numeric(12,2) not null default 0;
      alter table ordenes add column if not exists invoice_queued_at timestamptz;
      alter table ordenes add column if not exists andreani_handed_over_at timestamptz;
      alter table ordenes add column if not exists andreani_envio_id text;
      alter table ordenes add column if not exists tracking_number text;
      alter table ordenes add column if not exists andreani_tracking text`)
    await db.exec(block(directCancellation, "create or replace function public.order_has_admin_direct_cancellation("))
    await db.exec(block(migration, "create or replace function public.begin_partial_credit_note("))
    await db.query("select set_config('request.jwt.claim.role','service_role',false)")
    const admin = "10000000-0000-4000-8000-000000000003"
    const customer = "10000000-0000-4000-8000-000000000001"
    await db.query("insert into auth.users values($1,'a@example.test',now()),($2,'c@example.test',now())", [admin, customer])
    await db.query("insert into profiles(id,email,rol) values($1,'a@example.test','admin'),($2,'c@example.test','cliente')", [admin, customer])
    await db.query(`insert into ordenes(id,usuario_id,estado,total,invoice_status,invoice_cae,invoice_number,invoice_point,
      payment_confirmed_amount,external_amount_due,financial_status) values (2,$1,'cancelado',1000,'authorized','CAE',8,1,1000,1000,'refunded')`, [customer])
    await db.query("insert into orden_items(id,orden_id,cantidad) values (2,2,1)")
    await db.query(`insert into order_audit_events(order_id,actor_type,action,metadata)
      values (2,'admin','order_cancelled_refund_pending','{"source":"admin_direct_cancellation"}'::jsonb)`)

    const creditItems = buildLegacyCreditNoteItems(
      [{ id: 2, producto_id: 1, variante_id: 1, conditioned_name: null, cantidad: 1, precio: 1000 }],
      allocateEffectiveOrderItemAmounts({ total: 1000, shipping_cost_charged: 0 }, [{ id: 2, cantidad: 1, precio: 1000 }]),
      [{ order_item_id: 2, product_name: "ENCENDEDOR ELECTRICO CON CARGA USB", variant_name: "ALEATORIO" }],
      new Map(), new Map(),
    )
    assert.ok(creditItems.items)
    const reserve = (destination: string, expected: string[]) => db.query<{ id: string; external_amount: string | null; customer_credit_amount: string }>(
      `select id, external_amount, customer_credit_amount from begin_partial_credit_note(2::bigint,null,$1,'Caso heredado',1000::numeric,0::numeric,1000::numeric,1,8::bigint,$2::uuid,$4::jsonb,'cancelacion_antes_despacho',$3::uuid[])`,
      [destination, admin, expected, JSON.stringify(creditItems.items)],
    )
    // Un pedido ya reintegrado nunca recibe una NC que mueva dinero.
    await assert.rejects(reserve("external_refund", []), /ORDER_ALREADY_REFUNDED/)
    await assert.rejects(reserve("customer_balance", []), /ORDER_ALREADY_REFUNDED/)
    // La NC heredada (destino none) sí: anula la factura sin dinero ni saldo.
    const note = (await reserve("none", [])).rows[0]
    assert.ok(note.id)
    assert.equal(Number(note.external_amount ?? 0), 0, "sin dinero externo")
    assert.equal(Number(note.customer_credit_amount), 0)
    assert.deepEqual((await db.query<{ product_name: string; variant_name: string; quantity: number }>(
      "select product_name, variant_name, quantity from order_credit_note_items where credit_note_id=$1", [note.id],
    )).rows, [{ product_name: "ENCENDEDOR ELECTRICO CON CARGA USB", variant_name: "ALEATORIO", quantity: 1 }])
    // Doble click / dos pestañas: el segundo intento no reserva otra.
    await assert.rejects(reserve("none", []), /CREDIT_NOTE_SNAPSHOT_CONFLICT|CREDIT_NOTE_PROCESSING_IN_PROGRESS/)
    await assert.rejects(reserve("none", [note.id]), /CREDIT_NOTE_PROCESSING_IN_PROGRESS/)
    assert.equal(Number((await db.query<{ count: string }>("select count(*) from order_credit_notes where order_id=2")).rows[0].count), 1)
    assert.equal(Number((await db.query<{ count: string }>("select count(*) from order_credit_note_items where order_item_id=2")).rows[0].count), 1)
    assert.deepEqual((await db.query<{ financial_status: string; payment_status: string | null }>(
      "select financial_status, payment_status from ordenes where id=2",
    )).rows, [{ financial_status: "refunded", payment_status: null }])
    assert.deepEqual((await db.query<{ return_restocked_quantity: number | null; return_written_off_quantity: number | null }>(
      "select return_restocked_quantity, return_written_off_quantity from orden_items where id=2",
    )).rows, [{ return_restocked_quantity: null, return_written_off_quantity: null }])
    // Ya autorizada: la factura quedó cubierta, nunca una segunda NC.
    await db.query("update order_credit_notes set status='authorized' where id=$1", [note.id])
    await assert.rejects(reserve("none", [note.id]), /CREDIT_NOTE_EXCEEDS_INVOICE/)
    // Un operador no puede emitirla.
    await db.query("update profiles set rol='operador' where id=$1", [admin])
    await assert.rejects(reserve("none", [note.id]), /CREDIT_NOTE_ACTOR_FORBIDDEN/)
  } finally {
    await db.close()
  }
})
