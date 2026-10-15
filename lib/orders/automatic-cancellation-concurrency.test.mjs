import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// claim_auto_cancellation (20261015190000) con conexiones PostgreSQL REALES y
// simultáneas: dos workers nunca toman el mismo pedido, un lease vigente lo
// protege y uno vencido lo libera. Sin ARCA ni Mercado Pago.

// El cluster aislado de Windows nace en WIN1252: se reemplazan los símbolos
// que sólo aparecen en comentarios. El SQL ejecutado es el mismo.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replaceAll('→', '->')
const migration = read('../../supabase/migrations/20261015190000_automatic_cancellation_recovery.sql')
const claimSql = migration.slice(0, migration.indexOf('-- La sobrecarga con snapshot'))

test('cancelaciones automáticas: claim concurrente real, sin pedidos repetidos', { timeout: 180000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-auto-cancellation-pg')
  const clients = []
  const connect = async () => {
    const client = server.getPgClient('postgres', '127.0.0.1')
    await client.connect()
    clients.push(client)
    await client.query("set statement_timeout = '10s'")
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`)
    return client
  }
  try {
    await server.initialise(); await server.start()
    const db = await connect()
    await db.query(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end $$;
      create schema if not exists auth;
      create or replace function auth.role() returns text language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') $$;
      create table public.ordenes (id bigint primary key, estado text, financial_status text, invoice_status text,
        invoice_cae text, invoice_queued_at timestamptz, cancellation_requested_at timestamptz, cancelled_at timestamptz,
        refund_pending_at timestamptz, auto_cancellation_next_attempt_at timestamptz not null default '-infinity',
        auto_cancellation_claimed_until timestamptz, auto_cancellation_attempts integer not null default 0);
      create table public.arca_auto_invoicing_control (id boolean primary key, enabled boolean, cutoff_at timestamptz);
      insert into public.arca_auto_invoicing_control values (true, true, now() - interval '12 hours');
      create table public.order_credit_notes (id uuid primary key, order_id bigint, status text);
      create table public.profiles (id uuid primary key, rol text);`)
    await db.query(claimSql)
    const a = await connect(); const b = await connect()
    const insert = (id, queuedAgo = '1 hour') => db.query(`insert into public.ordenes values ($1,'cancelado','refund_pending','authorized',
      'CAE',now()-$2::interval,now(),now(),now())`, [id, queuedAgo])
    const claim = (client) => client.query("select id from public.claim_auto_cancellation('5 minutes')")

    await t.test('dos workers drenando la cola a la vez: cada pedido una sola vez', async () => {
      for (let id = 1; id <= 20; id += 1) await insert(id, id % 2 ? '1 hour' : '2 days')
      const taken = []
      const drain = async (client) => {
        for (;;) {
          const { rows } = await claim(client)
          if (!rows.length) return
          taken.push(Number(rows[0].id))
        }
      }
      await Promise.all([drain(a), drain(b)])
      assert.equal(taken.length, 20, 'incluye las compras de hace dos días canceladas después del corte')
      assert.equal(new Set(taken).size, 20, 'ningún pedido repetido entre workers')
      const attempts = await db.query('select count(*)::int n from public.ordenes where auto_cancellation_attempts <> 1')
      assert.equal(attempts.rows[0].n, 0)
    })

    await t.test('lease vigente protege; vencido (worker muerto) se retoma una sola vez', async () => {
      await insert(100)
      assert.equal(Number((await claim(a)).rows[0].id), 100)
      const [first, second] = await Promise.all([claim(a), claim(b)])
      assert.equal(first.rows.length + second.rows.length, 0, 'lease vigente: nadie lo toca')
      await db.query("update public.ordenes set auto_cancellation_claimed_until = now() - interval '1 second' where id=100")
      const [retryA, retryB] = await Promise.all([claim(a), claim(b)])
      assert.deepEqual([...retryA.rows, ...retryB.rows].map((row) => Number(row.id)), [100])
    })

    await t.test('backlog previo a la activación (venta y cancelación anteriores al corte) queda para Admin', async () => {
      await db.query(`insert into public.ordenes values (200,'cancelado','refund_pending','authorized','CAE',
        now()-interval '2 days',now()-interval '1 day',now()-interval '1 day',now()-interval '1 day')`)
      assert.equal((await claim(a)).rows.length, 0)
    })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
