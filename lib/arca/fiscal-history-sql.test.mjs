import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

const migration = readFileSync(new URL('../../supabase/migrations/20261003130000_admin_fiscal_history.sql', import.meta.url), 'utf8')
const numericOrderMigration = readFileSync(new URL('../../supabase/migrations/20261003141000_admin_fiscal_history_numeric_order.sql', import.meta.url), 'utf8')

test('historial fiscal: fechas argentinas, filtros, paginación y aislamiento por rol', { timeout: 120000 }, async () => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-fiscal-history')
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
        id bigint primary key, cliente_nombre text, cliente_dni text, total numeric,
        invoice_requested_total numeric, invoice_point integer, invoice_number bigint,
        invoice_cae text, invoice_status text, invoice_created_at timestamptz,
        invoice_arca_environment text
      );
      create table public.order_credit_notes (
        id uuid primary key, order_id bigint references public.ordenes(id),
        voucher_point integer, voucher_number bigint, cae text, status text,
        arca_environment text, authorized_at timestamptz, total_amount numeric,
        reason text, invoice_point integer, invoice_number bigint
      );
    `)
    await db.query(migration)
    await db.query(numericOrderMigration)
    await db.query(`
      insert into ordenes values
        (18, 'Lucas Espinosa', '30111222', 900, 100, 1, 2, 'CAE-A', 'authorized', '2026-10-04 02:30:00+00', 'production'),
        (19, 'María Núñez', '29111333', 200, 200, 1, 3, 'CAE-B', 'authorized', '2026-10-04 12:00:00+00', 'production'),
        (20, 'Otro año', '33111444', 300, 300, 1, 4, 'CAE-C', 'authorized', '2027-10-04 12:00:00+00', 'production'),
        (21, 'Pendiente', null, 400, null, null, null, null, 'pending', null, null);
      insert into order_credit_notes values
        ('00000000-0000-4000-8000-000000000001', 18, 1, 1, 'NC-A', 'authorized', 'production', '2026-10-04 02:40:00+00', 40, 'Devolución parcial', 1, 2),
        ('00000000-0000-4000-8000-000000000002', 19, 1, 2, 'NC-B', 'authorized', 'production', '2026-10-04 13:00:00+00', 20, 'Ajuste', 1, 3);
    `)
    await db.query("set request.jwt.claim.role = 'service_role'")
    const search = async (sql) => (await db.query(`select search_admin_fiscal_history(${sql}) as result`)).rows[0].result

    const today = await search("p_kind=>'invoice', p_from=>'2026-10-03', p_to=>'2026-10-04'")
    assert.equal(today.total, 1)
    assert.equal(today.items[0].id, '18')
    assert.equal(today.items[0].day, '2026-10-03')
    assert.equal(Number(today.items[0].amount), 100, 'usa el importe fiscal persistido')

    const month = await search("p_kind=>'invoice', p_from=>'2026-10-01', p_to=>'2026-11-01'")
    assert.equal(month.total, 2, 'no mezcla octubre de 2027')
    assert.deepEqual(month.items.map((item) => item.id), ['19', '18'])
    const firstPage = await search("p_kind=>'invoice', p_from=>'2026-10-01', p_to=>'2026-11-01', p_page_size=>1")
    const secondPage = await search("p_kind=>'invoice', p_from=>'2026-10-01', p_to=>'2026-11-01', p_page=>2, p_page_size=>1")
    assert.deepEqual([firstPage.items[0].id, secondPage.items[0].id], ['19', '18'])
    assert.equal((await search("p_kind=>'invoice', p_search=>'BX-1018'")).items[0].id, '18')
    assert.equal((await search("p_kind=>'invoice', p_number=>'0001-00000002'")).items[0].id, '18')
    assert.equal((await search("p_kind=>'invoice', p_client=>'lucas', p_document=>'30111222', p_cae=>'CAE-A', p_amount=>100, p_status=>'authorized'")).total, 1)
    assert.equal((await search("p_kind=>'invoice', p_status=>'error'")).total, 0)

    await db.query(`
      insert into ordenes values
        (9, 'Primero', null, 100, 100, 1, 9, 'CAE-9', 'authorized', '2026-10-05 15:00:00+00', 'production'),
        (10, 'Segundo', null, 100, 100, 1, 10, 'CAE-10', 'authorized', '2026-10-05 15:00:00+00', 'production'),
        (11, 'Tercero', null, 100, 100, 1, 11, 'CAE-11', 'authorized', '2026-10-05 15:00:00+00', 'production');
    `)
    const sameTime = await search("p_kind=>'invoice', p_from=>'2026-10-05', p_to=>'2026-10-06'")
    assert.deepEqual(sameTime.items.map((item) => item.id), ['11', '10', '9'])
    assert.equal('sort_order_id' in sameTime.items[0], false, 'la clave interna no cambia el JSON público')

    const notes = await search("p_kind=>'credit_note', p_from=>'2026-10-03', p_to=>'2026-10-04'")
    assert.equal(notes.total, 1)
    assert.equal(notes.items[0].reason, 'Devolución parcial')
    assert.equal(notes.items[0].day, '2026-10-03')
    assert.equal(notes.items[0].original_number, 2)
    assert.equal((await search("p_kind=>'credit_note', p_search=>'Núñez'")).total, 1)

    await db.query("set request.jwt.claim.role = 'authenticated'")
    await assert.rejects(search("p_kind=>'invoice'"), /FORBIDDEN/)
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
