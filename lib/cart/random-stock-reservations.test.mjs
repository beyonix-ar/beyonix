import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const oldMigration = read('../../supabase/migrations/20260903150000_checkout_stock_reservation_window.sql')
const legacyAvailable = oldMigration.match(/create or replace function public\.available_stock_for_session\([\s\S]*?\n\$\$;/)?.[0]
const catalogMigration = read('../../supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql')
const randomAvailable = catalogMigration.match(/create or replace function public\.available_stock_for_session\([\s\S]*?\n\$\$;/)?.[0]
const randomReserve = catalogMigration.match(/create or replace function public\.reserve_cart_stock\([\s\S]*?\n\$\$;/)?.[0]
assert.ok(legacyAvailable && randomAvailable && randomReserve)

test('venta aleatoria: reservas reales con PostgreSQL, dos conexiones', { timeout: 180000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-random-reservation-pg')
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
    await db.query(read('../inventory/fixtures/inventory-hardening-schema.sql'))
    await db.query("create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$")
    await db.query(legacyAvailable)
    await db.query('create function public.complete_cart_stock_reservation(text,bigint) returns void language sql as $$ select $$')
    await db.query("create function public.validate_checkout_inventory_reservation(jsonb,text,bigint) returns jsonb language sql as $$ select '{}'::jsonb $$")
    await db.query(read('../../supabase/migrations/20260925120000_checkout_step_stock_reservations.sql'))
    await db.query('alter table productos add column venta_aleatoria boolean not null default false')
    await db.query(randomAvailable)
    await db.query(randomReserve)
    const a = await connect(); const b = await connect()
    let nextSession = 0
    const session = () => `random-step-${++nextSession}-aaaaaaaa`
    const product = async (variants, random = true) => {
      const id = (await db.query('insert into productos(stock, venta_aleatoria) values($1,$2) returning id',
        [variants.reduce((sum, stock) => sum + stock, 0), random])).rows[0].id
      const ids = []
      for (const stock of variants) ids.push(Number((await db.query(
        'insert into producto_variantes(producto_id,stock) values($1,$2) returning id', [id, stock])).rows[0].id))
      return { id, variants: ids }
    }
    const reserve = (client, key, items) => client.query('select reserve_cart_stock($1,$2) as result', [key, JSON.stringify(items)])
    const randomItem = (p, quantity) => ({ productId: p.id, variantId: null, quantity })
    const reserved = async (key) => (await db.query(
      'select variant_id, quantity from stock_reservations where session_id=$1 order by variant_id', [key])).rows
      .map((row) => [Number(row.variant_id), Number(row.quantity)])
    const available = async (p, variantId = null) => Number((await db.query(
      'select available_stock_for_session($1,$2,null,null) as n', [p.id, variantId])).rows[0].n)
    const code = (error) => error.message.match(/OUT_OF_STOCK|INVALID_QUANTITY|INVALID_VARIANT/)?.[0]

    await t.test('stock total = suma de variantes físicas (Negro 4, Rojo 3, Azul 2 → 9)', async () => {
      const p = await product([4, 3, 2])
      assert.equal(await available(p), 9)
      assert.equal(await available(p, p.variants[0]), 4, 'cada variante conserva su stock propio')
    })

    await t.test('compra de 2 aleatorias: reserva 2 unidades REALES del pool (nunca un color inexistente)', async () => {
      const p = await product([4, 3, 2]); const key = session()
      await reserve(a, key, [randomItem(p, 2)])
      assert.deepEqual(await reserved(key), [[p.variants[0], 2]], 'la variante con más disponibilidad primero')
      assert.equal(await available(p), 7)
    })

    await t.test('variante agotada no se usa; reparte entre las que tienen stock (Negro 0, Rojo 2, Azul 0 → 2)', async () => {
      const p = await product([0, 2, 0])
      assert.equal(await available(p), 2)
      const key = session()
      await reserve(a, key, [randomItem(p, 2)])
      assert.deepEqual(await reserved(key), [[p.variants[1], 2]])
      const other = session()
      assert.equal(code(await reserve(b, other, [randomItem(p, 1)]).then(() => null, (error) => error)), 'OUT_OF_STOCK')
    })

    await t.test('reparte entre varias variantes cuando una sola no alcanza', async () => {
      const p = await product([1, 1, 1]); const key = session()
      await reserve(a, key, [randomItem(p, 3)])
      assert.equal((await reserved(key)).reduce((sum, [, quantity]) => sum + quantity, 0), 3)
      assert.equal((await reserved(key)).length, 3)
    })

    await t.test('todas agotadas: OUT_OF_STOCK y no queda ninguna reserva', async () => {
      const p = await product([0, 0, 0]); const key = session()
      assert.equal(code(await reserve(a, key, [randomItem(p, 1)]).then(() => null, (error) => error)), 'OUT_OF_STOCK')
      assert.deepEqual(await reserved(key), [])
    })

    await t.test('stock aleatorio = 1, dos clientes simultáneos: sólo uno reserva', async () => {
      for (let round = 0; round < 5; round += 1) {
        const p = await product([0, 1, 0])
        const outcomes = await Promise.allSettled([
          reserve(a, session(), [randomItem(p, 1)]),
          reserve(b, session(), [randomItem(p, 1)]),
        ])
        assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1, 'sólo uno gana')
        assert.equal(code(outcomes.find((r) => r.status === 'rejected').reason), 'OUT_OF_STOCK')
        assert.equal(await available(p), 0, 'nunca negativo ni sobrevendido')
      }
    })

    await t.test('cancelar/vaciar libera las unidades reservadas del pool', async () => {
      const p = await product([0, 1, 0]); const key = session()
      await reserve(a, key, [randomItem(p, 1)])
      assert.equal(await available(p), 0)
      await reserve(a, key, [])
      assert.equal(await available(p), 1)
    })

    await t.test('legacy: un producto con variantes que NO es aleatorio sigue exigiendo variante', async () => {
      const p = await product([2, 2], false)
      assert.equal(code(await reserve(a, session(), [randomItem(p, 1)]).then(() => null, (error) => error)), 'INVALID_VARIANT')
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
