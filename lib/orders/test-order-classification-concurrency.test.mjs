import assert from 'node:assert/strict'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'
import { OWNER, SECOND_SUPER, SETUP } from './fixtures/test-order-classification-db.mjs'

// PostgreSQL real con conexiones concurrentes, sobre las migraciones reales y
// las funciones REALES de recepción de devoluciones (BX-1019 / BX-1020,
// variante 22, stock inicial 6). En cada escenario una transacción toma sus
// locks y queda abierta; la otra se lanza, se verifica que ESPERA (no avanza
// ni falla) y, al confirmar la primera, termina sin deadlock y sin reingresar
// dos veces la misma unidad.

const REASON = 'Compra de prueba del checkout hecha por el propietario.'
const CLASSIFY = 'select public.classify_test_order_admin($1, $2, $3, $4, true) as r'
const RECEIVE = 'select (public.record_order_item_return_reception($1, $2, $3, 0, 0, $4, $5)).id as id'
const CLAIM_RECEIVE = "select (public.process_claim_return_inventory(1, $1, $2, 1, 0, 'Recepción del reclamo', $3, $4)).id as id"
const ADJUST = "select (public.adjust_variant_stock_idempotent(22, $1, 'Recuento físico', $2, $3)).stock as stock"

/** true si la promesa sigue pendiente después de `ms` (está esperando un lock). */
async function isWaiting(promise, ms = 400) {
  const marker = Symbol('pending')
  const result = await Promise.race([promise.then(() => 'done', () => 'failed'), new Promise((resolve) => setTimeout(() => resolve(marker), ms))])
  return result === marker
}

test('clasificación de pruebas: concurrencia real con recepciones, ajustes y reintentos', { timeout: 300000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-test-orders-pg')
  const clients = []
  let databaseIndex = 0
  try {
    await server.initialise(); await server.start()

    /** Base nueva con el seed real; devuelve conexiones a esa base. */
    const prepare = async () => {
      const name = `test_orders_${databaseIndex += 1}`
      await server.createDatabase(name)
      const connect = async () => {
        const client = server.getPgClient(name, '127.0.0.1')
        await client.connect()
        clients.push(client)
        await client.query("set statement_timeout = '20s'")
        await client.query("set request.jwt.claim.role = 'service_role'")
        return client
      }
      const db = await connect()
      for (const sql of SETUP) await db.query(sql)
      const stock = async () => Number((await db.query('select stock from producto_variantes where id = 22')).rows[0].stock)
      const count = async (sql) => Number((await db.query(`select count(*)::int as n ${sql}`)).rows[0].n)
      assert.equal(await stock(), 6)
      return { db, connect, stock, count }
    }

    await t.test('dos clasificaciones del mismo pedido: una aplica, la otra devuelve "ya clasificado"', async () => {
      const { connect, stock, count } = await prepare()
      const [a, b] = [await connect(), await connect()]
      await a.query('begin')
      const first = (await a.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])).rows[0].r
      const second = b.query(CLASSIFY, [19, SECOND_SUPER, REASON, 'BX-1019'])
      assert.equal(await isWaiting(second), true)
      await a.query('commit')
      const secondResult = (await second).rows[0].r
      assert.equal(first.alreadyClassified, false)
      assert.equal(secondResult.alreadyClassified, true)
      assert.equal(secondResult.test_order_by, OWNER)
      assert.equal(await stock(), 7)
      assert.equal(await count("from inventory_stock_adjustments"), 1)
      assert.equal(await count("from order_audit_events where order_id = 19 and action in ('order_archived', 'order_classified_as_test')"), 2)
    })

    await t.test('recepción directa en curso → la clasificación espera y no reingresa la misma unidad', async () => {
      const { connect, stock, count } = await prepare()
      const [reception, classification] = [await connect(), await connect()]
      await reception.query('begin')
      await reception.query(RECEIVE, [19, 26, 1, 'recepcion-concurrente', OWNER])
      const classified = classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
      assert.equal(await isWaiting(classified), true, 'espera el lock del ítem')
      await reception.query('commit')
      const result = (await classified).rows[0].r
      assert.deepEqual(result.restocked, [], 'el plan bajo lock ya ve la devolución')
      assert.equal(await stock(), 7, '6 + 1 devuelta, nunca 8')
      assert.equal(await count("from inventory_stock_adjustments"), 0)
    })

    await t.test('clasificación en curso → la recepción directa espera y se rechaza', async () => {
      const { connect, stock, count } = await prepare()
      const [classification, reception] = [await connect(), await connect()]
      await classification.query('begin')
      await classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
      const received = reception.query(RECEIVE, [19, 26, 1, 'recepcion-tardia', OWNER])
      assert.equal(await isWaiting(received), true, 'espera el lock del ítem')
      await classification.query('commit')
      await assert.rejects(received, /ORDER_TEST_STOCK_ALREADY_RESTORED/)
      assert.equal(await stock(), 7)
      assert.equal(await count("from inventory_return_movements where order_item_id = 26"), 0)
    })

    await t.test('recepción por reclamo (bloquea el pedido) contra clasificación, en ambos órdenes', async () => {
      {
        const { connect, stock } = await prepare()
        const [classification, claim] = [await connect(), await connect()]
        await classification.query('begin')
        await classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
        const received = claim.query(CLAIM_RECEIVE, [19, 26, OWNER, 'reclamo-tardio'])
        assert.equal(await isWaiting(received), true)
        await classification.query('commit')
        await assert.rejects(received, /ORDER_TEST_STOCK_ALREADY_RESTORED/)
        assert.equal(await stock(), 7)
      }
      {
        const { connect, stock, count } = await prepare()
        const [claim, classification] = [await connect(), await connect()]
        await claim.query('begin')
        await claim.query(CLAIM_RECEIVE, [19, 26, OWNER, 'reclamo-primero'])
        const classified = classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
        assert.equal(await isWaiting(classified), true)
        await claim.query('commit')
        assert.deepEqual((await classified).rows[0].r.restocked, [])
        assert.equal(await stock(), 7)
        assert.equal(await count("from inventory_stock_adjustments"), 0)
      }
    })

    await t.test('ajuste administrativo y clasificación, en ambos órdenes, sin deadlock ni pérdida', async () => {
      {
        const { connect, stock } = await prepare()
        const [admin, classification] = [await connect(), await connect()]
        await admin.query('begin')
        assert.equal(Number((await admin.query(ADJUST, [10, OWNER, 'recuento-primero'])).rows[0].stock), 10)
        const classified = classification.query(CLASSIFY, [20, OWNER, REASON, 'BX-1020'])
        assert.equal(await isWaiting(classified), true, 'espera el lock de inventario del producto')
        await admin.query('commit')
        const result = (await classified).rows[0].r
        assert.deepEqual(result.restocked.map((row) => [row.previousStock, row.newStock]), [[10, 11]])
        assert.equal(await stock(), 11, 'recuento 10 + 1 de BX-1020')
      }
      {
        const { connect, stock } = await prepare()
        const [classification, admin] = [await connect(), await connect()]
        await classification.query('begin')
        await classification.query(CLASSIFY, [20, OWNER, REASON, 'BX-1020'])
        const adjusted = admin.query(ADJUST, [10, OWNER, 'recuento-despues'])
        assert.equal(await isWaiting(adjusted), true)
        await classification.query('commit')
        assert.equal(Number((await adjusted).rows[0].stock), 10, 'el recuento absoluto se aplica sobre el stock ya reingresado')
        assert.equal(await stock(), 10)
      }
    })

    await t.test('recepciones repetidas del mismo ítem: una sola unidad; el reintento es idempotente', async () => {
      const { db, connect, count } = await prepare()
      const before = Number((await db.query('select stock from producto_variantes where id = 30')).rows[0].stock)
      const [a, b] = [await connect(), await connect()]
      await a.query('begin')
      const firstId = (await a.query(RECEIVE, [21, 28, 1, 'clave-a', OWNER])).rows[0].id
      const second = b.query(RECEIVE, [21, 28, 1, 'clave-b', OWNER])
      assert.equal(await isWaiting(second), true)
      await a.query('commit')
      await assert.rejects(second, /RETURN_EXCEEDS_REMAINING/)
      const retry = (await b.query(RECEIVE, [21, 28, 1, 'clave-a', OWNER])).rows[0].id
      assert.equal(retry, firstId)
      assert.equal(await count("from inventory_return_movements where order_item_id = 28"), 1)
      assert.equal(Number((await db.query('select stock from producto_variantes where id = 30')).rows[0].stock), before + 1)
    })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
