import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// `record_product_view` con conexiones PostgreSQL REALES y simultáneas
// (20261026100000 + 20261026120000): el doble montaje de React, dos pestañas o un doble
// refresh pueden mandar la misma vista a la vez y debe contar una sola.

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('product_view: vistas simultáneas de la misma sesión y producto cuentan una vez', { timeout: 240000 }, async () => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-analytics-pg')
  const clients = []
  const connect = async (database = 'beyonix') => {
    const client = server.getPgClient(database, '127.0.0.1')
    await client.connect()
    clients.push(client)
    if (database === 'beyonix') await client.query("set statement_timeout = '15s'")
    return client
  }
  try {
    await server.initialise(); await server.start()
    const admin = await connect('postgres')
    await admin.query("create database beyonix encoding 'UTF8' template template0")
    const db = await connect()
    await db.query(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users (id uuid primary key);
      create table public.productos (id bigint primary key, nombre text not null, slug text not null, activo boolean default true, imagen_principal text);
      create table public.producto_variantes (id bigint primary key, producto_id bigint not null);
      create table public.imagenes_producto (id bigint primary key, producto_id bigint, url text not null, orden integer default 0);
      insert into public.productos values (1, 'Auricular Malibu', 'auricular-malibu', true, null), (2, 'Pava 12V', 'pava-12v', true, null);`)
    await db.query(read('supabase/migrations/20261026100000_analytics_events_product_views.sql'))
    await db.query(read('supabase/migrations/20261026120000_analytics_history_merge_snapshots.sql'))
    const sessions = await Promise.all(Array.from({ length: 6 }, () => connect()))

    const record = (client, session, product) =>
      client.query('select public.record_product_view($1::uuid, $2) as status', [session, product]).then((result) => result.rows[0].status)

    const sameView = await Promise.all(sessions.map((client) => record(client, SESSION, 1)))
    assert.equal(sameView.filter((status) => status === 'recorded').length, 1, `una sola vista: ${sameView}`)
    assert.equal(sameView.filter((status) => status === 'duplicate').length, sessions.length - 1)

    const mixed = await Promise.all([
      record(sessions[0], OTHER_SESSION, 1),
      record(sessions[1], OTHER_SESSION, 1),
      record(sessions[2], SESSION, 2),
      record(sessions[3], SESSION, 2),
    ])
    assert.deepEqual(mixed.filter((status) => status === 'recorded').length, 2, 'otra sesión y otro producto cuentan una vez cada uno')
    const { rows } = await db.query('select session_id::text, product_id::int, count(*)::int as views from public.analytics_events group by 1, 2 order by 1, 2')
    assert.deepEqual(rows, [
      { session_id: SESSION, product_id: 1, views: 1 },
      { session_id: SESSION, product_id: 2, views: 1 },
      { session_id: OTHER_SESSION, product_id: 1, views: 1 },
    ])
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
