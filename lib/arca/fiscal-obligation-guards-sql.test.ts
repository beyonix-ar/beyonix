import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// 20261015180000: la obligación de Factura C y los CAE son inmutables, y una
// venta cancelada con un cambio de pedido pendiente no pierde la obligación.

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table ordenes (
      id bigint primary key, estado text, payment_status text, financial_status text, total numeric,
      cancelled_at timestamptz, cancellation_requested_at timestamptz, order_change_status text,
      invoice_queued_at timestamptz, invoice_cae text, invoice_status text
    );
    create table order_credit_notes (id uuid primary key default gen_random_uuid(), order_id bigint, status text, cae text);
    create function inventory_order_consumes_stock(text, text) returns boolean language sql as $$ select true $$;
    create function order_is_invoiceable(p_order ordenes) returns boolean language sql as $$
      select coalesce(p_order.estado,'') <> 'cancelado' and p_order.financial_status = 'payment_confirmed' and coalesce(p_order.total,0) > 0 $$;
    create table customer_credit_movements (id bigserial primary key, order_id bigint, movement_type text, amount numeric,
      source_type text, source_key text);
    create function customer_credit_movement_effect(p text) returns integer language sql immutable as $$
      select case when p in ('credit','reversal','adjustment') then 1 when p in ('debit','expiration') then -1 else 0 end $$;
    create function order_customer_credit_reversal_on_hold(p bigint) returns boolean language sql stable as $$
      select exists (select 1 from ordenes o where o.id = p and (o.invoice_queued_at is not null or o.invoice_cae is not null)) $$;
  `)
  await db.exec(readFileSync("supabase/migrations/20261015180000_fiscal_obligation_guards.sql", "utf8"))
  await db.exec(`insert into ordenes (id, estado, payment_status, financial_status, total, invoice_queued_at, invoice_cae, invoice_status)
    values (1,'pagado','approved','payment_confirmed',1000,now(),null,'pending'),
           (2,'cancelado','refunded','refunded',1000,now(),'86417596112941','authorized')`)
  return db
}

test("la obligación nacida con el pago no se borra por cancelación, reintegro ni UPDATE manual", async () => {
  const db = await setup()
  try {
    await db.exec("update ordenes set estado='cancelado', financial_status='refund_pending', invoice_status='error' where id=1")
    await assert.rejects(db.exec("update ordenes set invoice_queued_at=null where id=1"), /INVOICE_OBLIGATION_IMMUTABLE/)
    const row = (await db.query<{ queued: boolean }>("select invoice_queued_at is not null as queued from ordenes where id=1")).rows[0]
    assert.equal(row.queued, true)
  } finally { await db.close() }
})

test("un CAE nunca se reemplaza; una NC autorizada no vuelve atrás", async () => {
  const db = await setup()
  try {
    await assert.rejects(db.exec("update ordenes set invoice_cae='OTRO' where id=2"), /INVOICE_CAE_IMMUTABLE/)
    await assert.rejects(db.exec("update ordenes set invoice_cae=null where id=2"), /INVOICE_CAE_IMMUTABLE/)
    // Emitir el primer CAE sí está permitido.
    await db.exec("update ordenes set invoice_cae='86417747630716', invoice_status='authorized' where id=1")
    const note = (await db.query<{ id: string }>("insert into order_credit_notes(order_id,status) values (2,'processing') returning id")).rows[0].id
    await db.query("update order_credit_notes set status='authorized', cae='86417601283884' where id=$1", [note])
    await assert.rejects(db.query("update order_credit_notes set cae='OTRO' where id=$1", [note]), /CREDIT_NOTE_CAE_IMMUTABLE/)
    await assert.rejects(db.query("update order_credit_notes set status='error' where id=$1", [note]), /CREDIT_NOTE_AUTHORIZED_IMMUTABLE/)
  } finally { await db.close() }
})

test("venta cancelada con cambio de pedido pendiente: la obligación sigue exigible", async () => {
  const db = await setup()
  try {
    await db.exec("update ordenes set estado='cancelado', financial_status='refund_pending', order_change_status='change_requested' where id=1")
    const requires = (await db.query<{ r: boolean }>("select order_requires_invoice(o) r from ordenes o where id=1")).rows[0].r
    assert.equal(requires, true)
    // Sin pago confirmado nunca nació la obligación.
    await db.exec("insert into ordenes (id, estado, financial_status, total) values (3,'cancelado','cancelled',1000)")
    assert.equal((await db.query<{ r: boolean }>("select order_requires_invoice(o) r from ordenes o where id=3")).rows[0].r, false)
    // Cancelación sólo solicitada con un cambio en curso: se respeta la regla previa.
    await db.exec("insert into ordenes (id, estado, financial_status, total, invoice_queued_at, cancellation_requested_at, order_change_status) values (4,'pagado','cancellation_requested',1000,now(),now(),'change_requested')")
    assert.equal((await db.query<{ r: boolean }>("select order_requires_invoice(o) r from ordenes o where id=4")).rows[0].r, false)
  } finally { await db.close() }
})

test("saldo de una venta con obligación fiscal: sólo vuelve por NC (Admin no puede reversar el débito)", async () => {
  const db = await setup()
  try {
    const insert = (orderId: number | null, type: string, sourceType: string, key: string | null) => db.query(
      "insert into customer_credit_movements(order_id,movement_type,amount,source_type,source_key) values ($1,$2,30000,$3,$4)",
      [orderId, type, sourceType, key])
    // Reversa manual del Admin sobre el débito de la compra #2 (facturada).
    await assert.rejects(insert(2, "reversal", "reversal", "customer-credit:15:admin-reversal"), /CREDIT_NOTE_REQUIRED_BEFORE_REFUND/)
    await assert.rejects(insert(2, "credit", "admin_adjustment", "financial-resolution:x"), /CREDIT_NOTE_REQUIRED_BEFORE_REFUND/)
    // Por NC: acreditación a saldo y restauración del saldo usado.
    await insert(2, "credit", "credit_note", "credit-note:0001-00000005")
    await insert(2, "reversal", "reversal", "credit-note:ffe7b904:customer-credit-restoration")
    // Débitos, movimientos sin pedido y ventas sin obligación: sin cambios.
    await insert(2, "debit", "order", "order:2:debit")
    await insert(null, "credit", "admin_adjustment", null)
    await db.exec("insert into ordenes (id, estado, financial_status, total) values (9,'cancelado','cancelled',1000)")
    await insert(9, "reversal", "reversal", "order:9:customer-credit:reversal")
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from customer_credit_movements")).rows[0].n, 5)
  } finally { await db.close() }
})
