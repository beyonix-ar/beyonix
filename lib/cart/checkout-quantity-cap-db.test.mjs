import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Sin tope fijo de 3 por línea (20261029120000): la reserva del Paso 3 acepta
// cualquier cantidad que el stock real cubra, y sigue rechazando la que no.
// PostgreSQL real, varias conexiones; la RPC es la de la migración nueva.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const extract = (path, pattern) => {
  const match = read(path).match(pattern)?.[0]
  assert.ok(match, `no se encontró la función en ${path}`)
  return match
}
const legacyAvailable = extract('../../supabase/migrations/20260903150000_checkout_stock_reservation_window.sql',
  /create or replace function public\.available_stock_for_session\([\s\S]*?\n\$\$;/)
const randomAvailable = extract('../../supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql',
  /create or replace function public\.available_stock_for_session\([\s\S]*?\n\$\$;/)
const migration = read('../../supabase/migrations/20261029120000_remove_fixed_checkout_quantity_cap.sql')
const reserveFunction = migration.match(/create or replace function public\.reserve_cart_stock\([\s\S]*?\n\$\$;/)?.[0]
assert.ok(reserveFunction)

test('H. ninguna función de reserva/commit conserva un tope fijo de 3', () => {
  assert.doesNotMatch(migration, /\^\[123\]\$|quantity\)::integer\) > 3\b|r\.quantity > 3\b/)
  assert.equal(migration.match(/!~ '\^\[1-9\]\[0-9\]\{0,2\}\$'/g)?.length, 3, 'reserva + dos commits: 1..999')
  assert.equal(migration.match(/r\.quantity > 999/g)?.length, 2)
  for (const name of ['reserve_cart_stock', 'commit_mercadopago_checkout_reservation', 'commit_checkout_step_reservation']) {
    assert.match(migration, new RegExp(`create or replace function public\\.${name}\\(`))
  }
})

test('reserva sin tope fijo: manda el stock real (PostgreSQL real)', { timeout: 180000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-quantity-cap-pg')
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
    await db.query(reserveFunction)

    const buyers = [await connect(), await connect(), await connect(), await connect()]
    const [a, b] = buyers
    let nextSession = 0
    const session = () => `quantity-cap-${++nextSession}-aaaaaaaa`
    const product = async (stock, variants = []) => {
      const id = Number((await db.query('insert into productos(stock) values($1) returning id', [stock])).rows[0].id)
      const ids = []
      for (const quantity of variants) ids.push(Number((await db.query(
        'insert into producto_variantes(producto_id,stock) values($1,$2) returning id', [id, quantity])).rows[0].id))
      return { id, variants: ids }
    }
    const item = (p, quantity, variantId = null) => ({ productId: p.id, variantId, quantity })
    const reserve = (client, key, items) => client.query('select reserve_cart_stock($1,$2) as result', [key, JSON.stringify(items)])
    const reservedBy = async (key) => Number((await db.query(
      'select coalesce(sum(quantity),0)::integer as n from stock_reservations where session_id=$1', [key])).rows[0].n)
    const reservedTotal = async (p, variantId = null) => Number((await db.query(
      'select coalesce(sum(quantity),0)::integer as n from stock_reservations where product_id=$1 and variant_id is not distinct from $2 and expires_at>now()',
      [p.id, variantId])).rows[0].n)
    const available = async (p, variantId = null) => Number((await db.query(
      'select available_stock_for_session($1,$2,null,null) as n', [p.id, variantId])).rows[0].n)
    const code = (error) => error?.message.match(/OUT_OF_STOCK|INVALID_QUANTITY|INVALID_VARIANT/)?.[0]

    await t.test('A/F. sin variante: stock 10, compra 5 -> permitido', async () => {
      const p = await product(10); const key = session()
      await reserve(a, key, [item(p, 5)])
      assert.equal(await reservedBy(key), 5)
      assert.equal(await available(p), 5)
    })

    await t.test('B. stock 5, compra 5 -> permitido (todo el disponible)', async () => {
      const p = await product(5); const key = session()
      await reserve(a, key, [item(p, 5)])
      assert.equal(await reservedBy(key), 5)
      assert.equal(await available(p), 0)
    })

    await t.test('C. stock 4, compra 5 -> OUT_OF_STOCK, sin reserva parcial', async () => {
      const p = await product(4); const key = session()
      assert.equal(code(await reserve(a, key, [item(p, 5)]).then(() => null, (error) => error)), 'OUT_OF_STOCK')
      assert.equal(await reservedBy(key), 0)
      assert.equal(await available(p), 4)
      // Reconciliado a lo disponible, sí entra.
      await reserve(a, key, [item(p, 4)])
      assert.equal(await reservedBy(key), 4)
    })

    await t.test('G. con variante: 5 de una variante con stock 6 -> permitido; la otra variante no se toca', async () => {
      const p = await product(9, [6, 3]); const key = session()
      await reserve(a, key, [item(p, 5, p.variants[0])])
      assert.equal(await reservedTotal(p, p.variants[0]), 5)
      assert.equal(await available(p, p.variants[0]), 1)
      assert.equal(await available(p, p.variants[1]), 3)
      assert.equal(code(await reserve(b, session(), [item(p, 4, p.variants[1])]).then(() => null, (error) => error)), 'OUT_OF_STOCK')
    })

    await t.test('líneas repetidas de la misma variante se suman y se validan contra el stock real', async () => {
      const p = await product(6); const key = session()
      await reserve(a, key, [item(p, 3), item(p, 3)])
      assert.equal(await reservedBy(key), 6)
      assert.equal(code(await reserve(b, session(), [item(p, 4), item(p, 3)]).then(() => null, (error) => error)), 'OUT_OF_STOCK')
    })

    await t.test('E. reserva existente: el restante se respeta (stock 10, A reserva 6 -> B puede 4, no 5)', async () => {
      const p = await product(10)
      await reserve(a, session(), [item(p, 6)])
      assert.equal(await available(p), 4)
      assert.equal(code(await reserve(b, session(), [item(p, 5)]).then(() => null, (error) => error)), 'OUT_OF_STOCK')
      const key = session()
      await reserve(b, key, [item(p, 4)])
      assert.equal(await reservedBy(key), 4)
      assert.equal(await available(p), 0)
    })

    await t.test('D. compradores concurrentes de 5 contra stock 12: nunca más de 12 comprometidas', async () => {
      for (let round = 0; round < 3; round += 1) {
        const p = await product(12)
        const outcomes = await Promise.allSettled(buyers.map((client) => reserve(client, session(), [item(p, 5)])))
        assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 2, '2 x 5 = 10 entran; la tercera ya no')
        assert.ok(outcomes.filter((r) => r.status === 'rejected').every((r) => code(r.reason) === 'OUT_OF_STOCK'))
        assert.equal(await reservedTotal(p), 10)
        assert.equal(await available(p), 2, 'nunca negativo')
      }
      // Mezcla de cantidades grandes contra stock 7.
      const p = await product(7)
      await Promise.allSettled(buyers.map((client, index) => reserve(client, session(), [item(p, [5, 4, 3, 7][index])])))
      assert.ok(await reservedTotal(p) <= 7)
      assert.ok(await available(p) >= 0)
    })

    await t.test('sanidad: 0, negativos, fracciones, texto y más de 999 siguen siendo INVALID_QUANTITY', async () => {
      const p = await product(5000)
      for (const quantity of [0, -1, 1.5, 'x', 1000, '0005']) {
        assert.equal(code(await reserve(a, session(), [item(p, quantity)]).then(() => null, (error) => error)), 'INVALID_QUANTITY', String(quantity))
      }
      assert.equal(code(await reserve(a, session(), [item(p, 600), item(p, 600)]).then(() => null, (error) => error)), 'INVALID_QUANTITY')
      const key = session()
      await reserve(a, key, [item(p, 999)])
      assert.equal(await reservedBy(key), 999)
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
