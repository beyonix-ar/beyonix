import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

const migration = readFileSync(new URL('../../supabase/migrations/20261003140000_arca_invoice_item_snapshots.sql', import.meta.url), 'utf8')

test('Factura C conserva ítems y nombres al renombrar o eliminar el catálogo', { timeout: 120000 }, async () => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-invoice-snapshots')
  const clients = []
  try {
    await server.initialise(); await server.start()
    const db = server.getPgClient('postgres', '127.0.0.1')
    await db.connect(); clients.push(db)
    await db.query(`
      create schema auth;
      create function auth.role() returns text language sql stable as $$
        select nullif(current_setting('request.jwt.claim.role', true), '')
      $$;
      do $$ begin
        if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
      end $$;
      create table public.ordenes (
        id bigint primary key, invoice_requested_number bigint, invoice_cae text,
        invoice_status text, invoice_requested_total numeric, total numeric
      );
      create table public.productos (id bigint primary key, nombre text);
      create table public.producto_variantes (id bigint primary key, nombre text);
      create table public.orden_items (
        id bigint primary key, orden_id bigint references public.ordenes(id),
        producto_id bigint, variante_id bigint, conditioned_name text,
        cantidad numeric, precio numeric
      );
      insert into ordenes values (1, 1, 'CAE-1', 'authorized', 200, 999), (2, null, null, 'pending', null, 250);
      insert into productos values (10, 'Camisa original'), (11, 'Pantalón original');
      insert into producto_variantes values (20, 'Azul'), (21, 'Talle M');
      insert into orden_items values (100, 1, 10, 20, null, 2, 100), (101, 2, 11, 21, null, 1, 250);
    `)
    await db.query(migration)
    const rows = async (orderId) => (await db.query(
      'select quantity, unit_price, product_name, variant_name from arca_invoice_item_snapshots where order_id=$1 order by order_item_id', [orderId],
    )).rows
    assert.deepEqual((await rows(1)).map((item) => [item.product_name, item.variant_name]), [['Camisa original', 'Azul']])
    assert.equal(Number((await db.query('select fiscal_total from arca_invoice_header_snapshots where order_id=1')).rows[0].fiscal_total), 200)
    await db.query("set request.jwt.claim.role = 'service_role'")
    await db.query('update ordenes set invoice_requested_number=2 where id=2')
    const before = await rows(2)
    assert.equal(before[0].product_name, 'Pantalón original')
    assert.equal(before[0].variant_name, 'Talle M')
    assert.equal(Number(before[0].quantity), 1)
    assert.equal(Number(before[0].unit_price), 250)
    assert.equal(Number((await db.query('select fiscal_total from arca_invoice_header_snapshots where order_id=2')).rows[0].fiscal_total), 250)
    await db.query("update productos set nombre='Nombre nuevo' where id in (10,11)")
    await db.query("update producto_variantes set nombre='Variante nueva' where id in (20,21)")
    await db.query('delete from productos where id in (10,11)')
    await db.query('delete from producto_variantes where id in (20,21)')
    await db.query('update ordenes set total=777 where id=2')
    assert.equal((await rows(1))[0].product_name, 'Camisa original')
    assert.equal((await rows(1))[0].variant_name, 'Azul')
    assert.deepEqual(await rows(2), before)
    assert.equal(Number((await db.query('select fiscal_total from arca_invoice_header_snapshots where order_id=2')).rows[0].fiscal_total), 250)
    await db.query("set request.jwt.claim.role = 'authenticated'")
    await assert.rejects(db.query('update ordenes set invoice_requested_number=3 where id=2'), /FORBIDDEN/)
    await db.query('set role authenticated')
    await assert.rejects(db.query('select * from arca_invoice_header_snapshots'), /permission denied/)
    await assert.rejects(db.query('select * from arca_invoice_item_snapshots'), /permission denied/)
    await db.query('reset role')
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
