import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Cierre de reintegros MP con conexiones PostgreSQL REALES y simultáneas
// (20261015120000 + 20261015170000): webhooks repetidos en paralelo, refund
// confirmado mientras se autoriza la NC, dos refunds confirmándose a la vez y
// dos workers de conciliación. Esperado: una sola consecuencia por evento.

// El cluster aislado de Windows nace en WIN1252: se reemplazan los símbolos
// que sólo aparecen en comentarios. El SQL ejecutado es el mismo.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  .replaceAll('→', '->').replaceAll('↔', '<->')

test('reintegros MP: concurrencia real sin consecuencias duplicadas', { timeout: 180000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-refund-closure-pg')
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
      create table public.ordenes (id bigint primary key, financial_status text);
      create table public.order_credit_notes (
        id uuid primary key default gen_random_uuid(), order_id bigint not null, status text not null,
        destination text not null, total_amount numeric(12,2) not null, external_amount numeric(12,2),
        management_status text not null default 'reembolso_pendiente', settlement_status text not null default 'pendiente',
        settlement_date date, settlement_reference text, authorized_at timestamptz, created_at timestamptz default now(),
        updated_at timestamptz default now());
      create table public.mercadopago_order_refunds (
        id uuid primary key default gen_random_uuid(), order_id bigint not null, payment_id text not null default '1',
        amount numeric(12,2) not null, is_partial boolean not null default false, status text not null default 'processing',
        mp_refund_id text, completed_at timestamptz, reconciliation_locked_at timestamptz, updated_at timestamptz not null default now());
      create table public.order_audit_events (id bigint generated always as identity primary key, order_id bigint not null,
        actor_type text not null, actor_id uuid, action text not null, previous_status text, new_status text, metadata jsonb,
        created_at timestamptz not null default now());`)
    await db.query(read('../../supabase/migrations/20261015120000_settle_credit_notes_after_mp_refund.sql'))
    await db.query(read('../../supabase/migrations/20261015170000_mercadopago_refund_closure.sql'))
    const a = await connect(); const b = await connect()
    let nextOrder = 100
    const order = async () => {
      const id = nextOrder++
      await db.query("insert into public.ordenes values ($1, 'refund_pending')", [id])
      return id
    }
    const count = async (sql, params) => Number((await db.query(sql, params)).rows[0].n)

    await t.test('mismo refund externo informado por dos webhooks a la vez: una sola alerta', async () => {
      for (let round = 0; round < 5; round += 1) {
        const id = await order()
        const key = `mp_refund:EXT-${id}`
        const record = (client) => client.query(
          "select public.record_mercadopago_payment_incident($1,'mp_external_refund_detected',$2,'{\"amount\":10000}'::jsonb) as recorded", [id, key])
        const results = await Promise.all([record(a), record(b), record(a), record(b)])
        assert.equal(results.filter((result) => result.rows[0].recorded).length, 1)
        assert.equal(await count("select count(*) n from public.order_audit_events where order_id=$1 and action='mp_external_refund_detected'", [id]), 1)
      }
    })

    await t.test('refund confirmado mientras otra conexión autoriza la NC: se liquida una sola vez', async () => {
      for (let round = 0; round < 5; round += 1) {
        const id = await order()
        const note = (await db.query(`insert into public.order_credit_notes(order_id,status,destination,total_amount,external_amount)
          values ($1,'processing','external_refund',1000,1000) returning id`, [id])).rows[0].id
        const refund = (await db.query("insert into public.mercadopago_order_refunds(order_id,amount) values ($1,1000) returning id", [id])).rows[0].id
        await Promise.all([
          a.query("update public.order_credit_notes set status='authorized', authorized_at=now() where id=$1", [note]),
          b.query("update public.mercadopago_order_refunds set status='confirmed', mp_refund_id=$2, completed_at=now() where id=$1", [refund, `R-${id}`]),
        ])
        // Sin llamada manual: el lock por pedido serializa ambos triggers y el
        // segundo en tomarlo ve el cambio del primero ya confirmado.
        assert.equal(await count("select count(*) n from public.order_credit_notes where id=$1 and settlement_status='completado'", [note]), 1)
        assert.equal(await count("select count(*) n from public.order_audit_events where order_id=$1 and action='credit_note_settled_by_mp_refund'", [id]), 1)
      }
    })

    await t.test('dos refunds parciales confirmándose a la vez sobre dos NC: cada dinero liquida una sola NC', async () => {
      for (let round = 0; round < 5; round += 1) {
        const id = await order()
        for (const minutes of [10, 5]) {
          await db.query(`insert into public.order_credit_notes(order_id,status,destination,total_amount,external_amount,authorized_at)
            values ($1,'authorized','external_refund',500,500,now() - make_interval(mins => $2))`, [id, minutes])
        }
        const ids = []
        for (let index = 0; index < 2; index += 1) {
          ids.push((await db.query("insert into public.mercadopago_order_refunds(order_id,amount,is_partial) values ($1,500,true) returning id", [id])).rows[0].id)
        }
        await Promise.all(ids.map((refund, index) => (index ? b : a).query(
          "update public.mercadopago_order_refunds set status='confirmed', mp_refund_id=$2, completed_at=now() where id=$1", [refund, `P-${id}-${index}`])))
        assert.equal(await count("select count(*) n from public.order_credit_notes where order_id=$1 and settlement_status='completado'", [id]), 2)
        assert.equal(await count("select count(*) n from public.order_audit_events where order_id=$1 and action='credit_note_settled_by_mp_refund'", [id]), 2)
      }
    })

    await t.test('dos workers de conciliación a la vez nunca toman el mismo intento', async () => {
      const id = await order()
      for (let index = 0; index < 6; index += 1) {
        await db.query("insert into public.mercadopago_order_refunds(order_id,amount,status,updated_at) values ($1,100,'needs_reconciliation',now() - interval '1 hour')", [id])
      }
      await db.query("insert into public.mercadopago_order_refunds(order_id,amount,status,updated_at) values ($1,100,'processing',now() - interval '20 minutes')", [id])
      const [first, second] = await Promise.all([
        a.query('select id from public.claim_mercadopago_refunds_for_reconciliation(4, 300)'),
        b.query('select id from public.claim_mercadopago_refunds_for_reconciliation(4, 300)'),
      ])
      const taken = [...first.rows, ...second.rows].map((row) => row.id)
      assert.equal(new Set(taken).size, taken.length, 'sin intentos repetidos entre workers')
      assert.equal(taken.length, 7, 'incluye el processing colgado')
    })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
