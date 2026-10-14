import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Saldo a favor con conexiones PostgreSQL REALES y simultáneas
// (20261014120000): doble cancelación, la NC autorizándose mientras se
// cancela, y dos NC parciales autorizadas a la vez -> una restauración por NC.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const fn = (name) => read('../../supabase/migrations/20260911130000_harden_customer_credit_rpc_authorization.sql')
  .match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$function\\$[\\s\\S]*?\\$function\\$;`))[0]

const user = '20000000-0000-4000-8000-000000000001'
const migration = read('../../supabase/migrations/20261014130000_credit_note_fiscal_vs_money_split.sql')
const migrationFunction = (name) => {
  const start = migration.indexOf(`create or replace function public.${name}(`)
  return migration.slice(start, migration.indexOf('$$;', migration.indexOf('as $$', start)) + 3)
}

test('saldo a favor: cancelaciones y NC concurrentes restauran una sola vez', { timeout: 180000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-credit-reversal-pg')
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
    await db.query(read('./fixtures/credit-reversal-order-due.sql'))
    await db.query(`
      alter table public.ordenes add column invoice_queued_at timestamptz, add column invoice_cae text;
      create table public.order_credit_notes (id uuid primary key default gen_random_uuid(), order_id bigint, status text, created_by uuid,
        customer_credit_amount numeric(12,2) not null default 0);
      create table public.order_audit_events (id bigint generated always as identity primary key, order_id bigint,
        actor_type text, actor_id uuid, action text, previous_status text, new_status text, metadata jsonb,
        created_at timestamptz default now());`)
    await db.query(fn('get_customer_credit_balance'))
    await db.query(fn('apply_customer_credit_to_order'))
    // El cluster aislado de Windows nace en WIN1252: "→" (sólo en comentarios)
    // no existe ahí. Supabase es UTF-8; el SQL ejecutado es el mismo.
    await db.query(read('../../supabase/migrations/20261014120000_customer_credit_reversal_after_credit_note.sql').replaceAll('→', '->'))
    await db.query(migrationFunction('order_customer_credit_reversal_on_hold'))
    await db.query(migrationFunction('restore_customer_credit_after_credit_note').replaceAll('é', 'e'))
    await db.query('insert into auth.users (id) values ($1)', [user])
    const a = await connect(); const b = await connect()

    let nextId = 1
    const invoicedOrderWithCredit = async () => {
      const id = nextId++
      await db.query(`insert into public.customer_credit_movements (user_id, movement_type, amount, description, source_type, resulting_balance)
        values ($1, 'credit', 30000, 'Carga', 'admin_adjustment', 30000)`, [user])
      await db.query(`insert into public.ordenes (id, usuario_id, total, original_total, external_amount_due, estado, invoice_queued_at, invoice_cae)
        values ($1,$2,100000,100000,100000,'pagado',now(),'CAE')`, [id, user])
      await db.query('select * from public.apply_customer_credit_to_order($1, $2, 30000)', [user, id])
      await db.query("update public.ordenes set estado='cancelado', financial_status='refund_pending' where id=$1", [id])
      return id
    }
    const reverse = (client, id) => client.query("select * from public.reverse_customer_credit_for_order($1, 'Cancelación')", [id])
    const reversals = async (id) => Number((await db.query(
      "select count(*)::int n from public.customer_credit_movements where order_id=$1 and movement_type='reversal'", [id])).rows[0].n)

    await t.test('doble click de cancelar sin NC: ninguna restauración', async () => {
      const id = await invoicedOrderWithCredit()
      await Promise.all([reverse(a, id), reverse(b, id)])
      assert.equal(await reversals(id), 0)
    })

    await t.test('NC autorizándose mientras otra conexión cancela: una sola restauración', async () => {
      for (let round = 0; round < 5; round += 1) {
        const id = await invoicedOrderWithCredit()
        await db.query("insert into public.order_credit_notes (order_id, status, customer_credit_amount) values ($1, 'processing', 30000)", [id])
        await Promise.allSettled([
          a.query("update public.order_credit_notes set status='authorized' where order_id=$1", [id]),
          reverse(b, id),
        ])
        await reverse(a, id)
        assert.equal(await reversals(id), 1, `ronda ${round}`)
      }
    })

    await t.test('dos NC parciales autorizadas y dos cancelaciones a la vez: una restauración por NC', async () => {
      const id = await invoicedOrderWithCredit()
      const authorizations = await Promise.allSettled([
        a.query("insert into public.order_credit_notes (order_id, status, customer_credit_amount) values ($1, 'authorized', 15000)", [id]),
        b.query("insert into public.order_credit_notes (order_id, status, customer_credit_amount) values ($1, 'authorized', 15000)", [id]),
      ])
      assert.ok(authorizations.every((result) => result.status === 'fulfilled'), 'ambas NC deben autorizarse')
      await Promise.all([reverse(a, id), reverse(b, id)])
      assert.equal(await reversals(id), 2)
      const credited = Number((await db.query(
        "select coalesce(sum(amount),0) s from public.customer_credit_movements where order_id=$1 and movement_type='reversal'", [id])).rows[0].s)
      assert.equal(credited, 30000)
      await db.query("update public.order_credit_notes set status='authorized' where order_id=$1", [id])
      assert.equal(await reversals(id), 2, 'un reintento no duplica movimientos')
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
