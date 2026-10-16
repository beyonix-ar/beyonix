import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Despachos con conexiones PostgreSQL REALES y simultáneas (20261016100000):
// dos dispositivos resolviendo el mismo retiro físico, la carrera entre la
// cancelación y el escaneo que completa el armado, y dos operadores con la
// última unidad. Mismas migraciones que dispatch-cancellation-hold-db.test.ts.

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const SETUP = [
  'lib/orders/fixtures/dispatch-schema.sql',
  'supabase/migrations/20260820120000_cost_catalog_barcode.sql',
  'supabase/migrations/20261005100000_dispatch_operations.sql',
  'supabase/migrations/20261005110000_dispatch_guards.sql',
  'supabase/migrations/20261007100000_barcodes_parcels_dispatch.sql',
  'lib/orders/fixtures/dispatch-inventory-schema.sql',
  'supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql',
  'supabase/migrations/20261009100000_random_fulfillment_traceability.sql',
  'supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql',
  'supabase/migrations/20260918100000_refresh_inventory_stock_fail_closed.sql',
  'supabase/migrations/20261016100000_dispatch_cancellation_physical_holds.sql',
  'supabase/migrations/20261016101000_dispatch_hold_check_public_catalog.sql',
  'supabase/migrations/20261016110000_dispatch_hold_from_first_pick.sql',
  'supabase/migrations/20261016120000_cancellation_after_picking_manual_refund.sql',
  'supabase/migrations/20261016130000_picked_cancellation_admin_refund_only.sql',
]
const actor = '20000000-0000-4000-8000-000000000002'
let requestNumber = 0
const key = () => `70000000-0000-4000-8000-${String(++requestNumber).padStart(12, '0')}`
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('despachos: retiro físico, cancelación y último escaneo con conexiones concurrentes reales', { timeout: 240000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-dispatch-hold-pg')
  const clients = []
  const connect = async (database = 'beyonix') => {
    const client = server.getPgClient(database, '127.0.0.1')
    await client.connect()
    clients.push(client)
    if (database === 'beyonix') {
      await client.query("set statement_timeout = '15s'")
      await client.query("select set_config('request.jwt.claim.role', 'service_role', false)")
    }
    return client
  }
  try {
    await server.initialise(); await server.start()
    const admin = await connect('postgres')
    // El cluster de Windows nace en WIN1252: la base de prueba usa UTF8 como producción.
    await admin.query("create database beyonix encoding 'UTF8' template template0")
    const db = await connect()
    for (const file of SETUP) await db.query(read(file))
    await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
    const a = await connect(); const b = await connect()

    let nextOrder = 1100
    const newOrder = async (units = 1) => {
      const orderId = ++nextOrder
      const productId = orderId
      await db.query(`insert into productos(id,sku,codigo_barra,nombre) values ($1,$2,$3,'Producto de prueba')`, [productId, `SKU-${productId}`, `BAR-${productId}`])
      await db.query("insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ($1,$2,null)", [`SKU-${productId}`, productId])
      await db.query('insert into product_cost_entries(product_id,received_quantity) values ($1,$2)', [productId, units])
      await db.query('insert into ordenes(id) values ($1)', [orderId])
      await db.query('insert into orden_items(id,orden_id,producto_id,cantidad) values ($1,$1,$2,$3)', [orderId, productId, units])
      await db.query('select refresh_inventory_stock($1)', [productId])
      return { orderId, productId, code: `BAR-${productId}` }
    }
    const productStock = async (productId) => Number((await db.query('select stock from productos where id=$1', [productId])).rows[0].stock)
    const scan = (client, orderId, code) => client.query('select scan_order_preparation_code($1,$2,$3,$4) r', [orderId, code, actor, key()])
    const cancel = (client, orderId) => client.query("update ordenes set estado='cancelado',cancelled_at=now(),financial_status='refund_pending' where id=$1", [orderId])
    const holds = async (orderId) => Number((await db.query('select count(*)::int n from order_cancellation_holds where order_id=$1', [orderId])).rows[0].n)

    await t.test('U: dos dispositivos escanean el mismo pedido cancelado a la vez: stock y auditoría una sola vez', async () => {
      const order = await newOrder(3)
      await db.query('select begin_order_preparation($1,$2)', [order.orderId, actor])
      for (let unit = 0; unit < 3; unit += 1) await scan(db, order.orderId, order.code)
      await cancel(db, order.orderId)
      assert.equal(await productStock(order.productId), 0, 'retenido')
      const code = `BX-PREP-${1000 + order.orderId}`
      const resolveWith = (client) => client.query('select resolve_cancelled_order_preparation($1,$2,$3,null) r', [code, actor, key()])
      const results = await Promise.all([settle(resolveWith(a)), settle(resolveWith(b))])
      assert.ok(results.every((result) => result.ok), 'ninguno falla: el segundo ve el pedido ya resuelto')
      const fresh = results.filter((result) => !result.value.rows[0].r.alreadyResolved)
      assert.equal(fresh.length, 1, 'sólo uno resuelve')
      assert.equal(await productStock(order.productId), 3, 'vuelven exactamente 3 unidades, no 6')
      const audit = await db.query("select count(*)::int n from order_audit_events where order_id=$1 and action='dispatch_cancellation_stock_restored'", [order.orderId])
      assert.equal(audit.rows[0].n, 1)
    })

    await t.test('cancelación mientras se escanea la última unidad: el escaneo gana, la cancelación espera y retiene', async () => {
      const order = await newOrder(1)
      await db.query('select begin_order_preparation($1,$2)', [order.orderId, actor])
      await a.query('begin')
      await scan(a, order.orderId, order.code)
      const cancelling = settle(cancel(b, order.orderId))
      await pause(300)
      await a.query('commit')
      const outcome = await cancelling
      assert.ok(outcome.ok, outcome.error?.message)
      assert.equal(await holds(order.orderId), 1, 'la cancelación vio el armado completo y retuvo el stock')
      assert.equal(await productStock(order.productId), 0)
    })

    await t.test('cancelación primero: el último escaneo espera y se rechaza; el stock vuelve como hoy', async () => {
      const order = await newOrder(1)
      await db.query('select begin_order_preparation($1,$2)', [order.orderId, actor])
      await b.query('begin')
      await cancel(b, order.orderId)
      const scanning = settle(scan(a, order.orderId, order.code))
      await pause(300)
      await b.query('commit')
      const outcome = await scanning
      assert.equal(outcome.ok, false)
      assert.match(outcome.error.message, /DISPATCH_ORDER_BLOCKED/)
      assert.equal(await holds(order.orderId), 0)
      const pkg = await db.query('select status from order_packages where order_id=$1', [order.orderId])
      assert.equal(pkg.rows[0].status, 'preparing', 'nunca queda armado un pedido cancelado')
      assert.equal(await productStock(order.productId), 1)
    })

    await t.test('primer escaneo (1 de 3) gana: la cancelación espera y retiene con 1 unidad pickeada', async () => {
      const order = await newOrder(3)
      await db.query('select begin_order_preparation($1,$2)', [order.orderId, actor])
      await a.query('begin')
      await scan(a, order.orderId, order.code)
      const cancelling = settle(cancel(b, order.orderId))
      await pause(300)
      await a.query('commit')
      const outcome = await cancelling
      assert.ok(outcome.ok, outcome.error?.message)
      const hold = await db.query('select picked_units, prepared from order_cancellation_holds where order_id=$1', [order.orderId])
      assert.deepEqual(hold.rows.map((row) => [row.picked_units, row.prepared]), [[1, false]])
      assert.equal(await productStock(order.productId), 0, 'nada vuelve solo')
    })

    await t.test('cancelación antes del primer escaneo: el escaneo espera y se rechaza; sin pickeo no hay retención', async () => {
      const order = await newOrder(3)
      await db.query('select begin_order_preparation($1,$2)', [order.orderId, actor])
      await b.query('begin')
      await cancel(b, order.orderId)
      const scanning = settle(scan(a, order.orderId, order.code))
      await pause(300)
      await b.query('commit')
      const outcome = await scanning
      assert.equal(outcome.ok, false)
      assert.match(outcome.error.message, /DISPATCH_ORDER_BLOCKED/)
      assert.equal(await holds(order.orderId), 0)
      const picked = await db.query('select count(*)::int n from order_preparation_scans s join order_packages p on p.id=s.package_id where p.order_id=$1', [order.orderId])
      assert.equal(picked.rows[0].n, 0, 'no queda un pickeo registrado de un cancelado')
      assert.equal(await productStock(order.productId), 3, 'circuito automático: vuelve el stock')
    })

    await t.test('dos operadores con la última unidad: se registra una sola', async () => {
      const order = await newOrder(1)
      await db.query('select begin_order_preparation($1,$2)', [order.orderId, actor])
      const results = await Promise.all([settle(scan(a, order.orderId, order.code)), settle(scan(b, order.orderId, order.code))])
      assert.equal(results.filter((result) => result.ok).length, 1)
      assert.match(results.find((result) => !result.ok).error.message, /DISPATCH_ALREADY_PREPARED|DISPATCH_QUANTITY_EXCEEDED/)
      const line = await db.query('select l.scanned_quantity from order_preparation_lines l join order_packages p on p.id=l.package_id where p.order_id=$1', [order.orderId])
      assert.equal(line.rows[0].scanned_quantity, 1)
    })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
