import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Dos Admins asignan la MISMA posición de destacado a productos distintos a la
// vez (PostgreSQL real, dos conexiones). El chequeo previo de la función no ve
// la escritura todavía sin confirmar del otro: la que decide es el índice
// único parcial, y el segundo falla limpio (23505, mensaje para Admin).

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const migration = read('../../supabase/migrations/20261102120000_product_featured_position.sql')

test('dos Admins con la posición 1 a la vez: uno gana, el otro falla limpio', { timeout: 180000 }, async () => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-featured-position-pg')
  const clients = []
  const connect = async () => {
    const client = server.getPgClient('postgres', '127.0.0.1')
    await client.connect()
    clients.push(client)
    await client.query("set statement_timeout = '10s'")
    await client.query("set request.jwt.claim.role = 'service_role'")
    return client
  }
  try {
    await server.initialise(); await server.start()
    const db = await connect()
    await db.query(`
      create schema if not exists auth;
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end $$;
      create or replace function auth.role() returns text language sql stable as $$
        select current_setting('request.jwt.claim.role', true)
      $$;
      create table public.productos (
        id bigint generated always as identity primary key,
        nombre text not null,
        destacado boolean not null default false,
        activo boolean not null default true,
        catalog_revision bigint not null default 0,
        created_at timestamptz not null default now()
      );
      insert into public.productos (nombre, destacado) values ('AURICULAR ÑANDÚ', false), ('LÁMPARA ÁMBAR', false);
    `)
    await db.query(migration)

    const [adminA, adminB] = [await connect(), await connect()]
    await adminA.query('begin')
    await adminA.query('select public.set_product_featured_position(1, true, 1)')
    // B queda esperando el índice único hasta que A confirme.
    const second = adminB.query('select public.set_product_featured_position(2, true, 1)')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await adminA.query('commit')

    await assert.rejects(second, (error) => {
      assert.equal(error.code, '23505')
      assert.match(error.message, /La posición 1 acaba de ocuparse/)
      return true
    })
    const { rows } = await db.query('select id, destacado, featured_position from public.productos order by id')
    assert.deepEqual(
      rows.map((row) => [Number(row.id), row.destacado, row.featured_position]),
      [[1, true, 1], [2, false, null]],
      'el perdedor no queda a medio escribir',
    )
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
