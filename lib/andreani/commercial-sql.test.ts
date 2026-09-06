import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

test("SQL real: permisos, interruptor comercial, claims repetidos y resultados inciertos", async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.role() returns text language sql as $$ select current_setting('test.role', true) $$;
      create table site_settings (key text primary key, value jsonb, description text);
      create table ordenes (
        id bigint primary key, estado text, shipping_provider text, envio_proveedor text, shipping_type text,
        financial_status text, paid_at timestamptz, payment_confirmed_amount numeric, payment_status text,
        invoice_status text, invoice_cae text, invoice_number integer, invoice_point integer,
        andreani_envio_id text, andreani_creation_status text, andreani_creation_claim_token uuid,
        andreani_creation_claimed_at timestamptz, andreani_creation_environment text,
        andreani_creation_attempts integer default 0, andreani_error text
      );
      grant all on ordenes to anon, authenticated, service_role;
      select set_config('test.role', 'service_role', false);
    `)
    await db.exec(readFileSync(new URL("../../supabase/migrations/20260906120000_harden_andreani_commercial_and_order_writes.sql", import.meta.url), "utf8"))
    const permissions = await db.query<{ can_insert: boolean; can_update: boolean; can_claim: boolean; can_read: boolean }>(`
      select has_table_privilege('authenticated','ordenes','INSERT') can_insert,
        has_table_privilege('authenticated','ordenes','UPDATE') can_update,
        has_function_privilege('authenticated','claim_andreani_shipment_creation(bigint,uuid,text)','EXECUTE') can_claim,
        has_table_privilege('authenticated','ordenes','SELECT') can_read
    `)
    assert.deepEqual(permissions.rows[0], { can_insert: false, can_update: false, can_claim: false, can_read: true })
    await db.exec(`insert into ordenes (id,estado,shipping_provider,shipping_type,financial_status,payment_status,invoice_status,invoice_cae,invoice_number,invoice_point)
      values (1,'pagado','andreani','domicilio','payment_confirmed','confirmado','authorized','test',1,1)`)
    const claim = async () => (await db.query<{ attempt: number | null }>(
      "select claim_andreani_shipment_creation(1,'123e4567-e89b-42d3-a456-426614174000','PROD') attempt",
    )).rows[0].attempt
    await db.exec(`update site_settings set value='{"enabled":false}' where key='andreani_commercial'`)
    assert.equal(await claim(), null)
    await db.exec(`update site_settings set value='{"enabled":"true"}' where key='andreani_commercial'`)
    assert.equal(await claim(), null)
    await db.exec(`update site_settings set value='{"enabled":true}' where key='andreani_commercial'`)
    assert.equal(await claim(), 1)
    assert.equal(await claim(), null)
    await db.exec("update ordenes set andreani_creation_claimed_at=now()-interval '6 minutes' where id=1")
    assert.equal(await claim(), null)
    const row = (await db.query<{ status: string; attempts: number }>("select andreani_creation_status status, andreani_creation_attempts attempts from ordenes where id=1")).rows[0]
    assert.deepEqual(row, { status: "reconciliation_required", attempts: 1 })
    await db.exec("update ordenes set andreani_creation_status='failed', estado='entregado' where id=1")
    assert.equal(await claim(), null)
    await db.exec("update ordenes set estado='pagado', shipping_provider='otro' where id=1")
    assert.equal(await claim(), null)
  } finally {
    await db.close()
  }
})
