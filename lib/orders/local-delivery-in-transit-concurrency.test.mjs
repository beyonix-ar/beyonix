import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Envío BEYONIX "Preparando → En camino" con conexiones PostgreSQL REALES y
// simultáneas, sólo con la migración A (antes de B): el código nuevo es
// seguro por sí mismo. Un rearmado o un cambio de bultos que se confirma
// mientras la RPC espera el lock nunca deja pasar el snapshot viejo.

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
  'supabase/migrations/20261016150000_dispatch_general_bundle_verification.sql',
  'supabase/migrations/20261016160000_dispatch_andreani_identification.sql',
  'supabase/migrations/20261017100000_dispatch_finalize_on_verification.sql',
  'supabase/migrations/20261017110000_super_admin_force_cancellation.sql',
  'supabase/migrations/20261021100000_dispatch_andreani_label_scan_confirmation.sql',
  // Migración A únicamente: la guarda global (B) todavía no existe.
  'supabase/migrations/20261103120000_local_delivery_parcels_labels.sql',
]
const actor = '20000000-0000-4000-8000-000000000002'
let requestNumber = 0
const key = () => `72000000-0000-4000-8000-${String(++requestNumber).padStart(12, '0')}`
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('En camino BEYONIX con A (sin B): rearmado y cambios de bultos concurrentes nunca avanzan con un snapshot viejo', { timeout: 240000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-local-in-transit-pg')
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
    await admin.query("create database beyonix encoding 'UTF8' template template0")
    const db = await connect()
    for (const file of SETUP) {
      await db.query(read(file))
      if (file.endsWith('dispatch-schema.sql')) await db.query(`
        alter table ordenes add column andreani_tracking text;
        alter table ordenes add column delivered_at timestamptz;
        alter table ordenes add column credit_note_required boolean default false;
        alter table ordenes add column invoice_number integer;
        alter table ordenes add column invoice_point integer;
        alter table ordenes add column cancellation_requested_by uuid;
        alter table orden_items add column precio numeric default 1000;
      `)
      if (file.endsWith('dispatch-inventory-schema.sql')) await db.query('alter table order_credit_notes add column total_amount numeric default 0;')
    }
    await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
    const a = await connect(); const b = await connect()

    let nextOrder = 1200
    // Pedido local listo para el cadete: pickeado, 1 bulto definido y confirmado.
    const readyOrder = async () => {
      const orderId = ++nextOrder
      await db.query(`insert into productos(id,sku,codigo_barra,nombre) values ($1,$2,$3,'Producto de prueba')`, [orderId, `SKU-${orderId}`, `BAR-${orderId}`])
      await db.query('insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ($1,$2,null)', [`SKU-${orderId}`, orderId])
      await db.query('insert into product_cost_entries(product_id,received_quantity) values ($1,5)', [orderId])
      await db.query("insert into ordenes(id,shipping_provider,andreani_envio_id,andreani_creation_status) values ($1,'beyonix',null,null)", [orderId])
      await db.query('insert into orden_items(id,orden_id,producto_id,cantidad) values ($1,$1,$1,1)', [orderId])
      await db.query('select refresh_inventory_stock($1)', [orderId])
      await db.query('select begin_order_preparation($1,$2)', [orderId, actor])
      await db.query('select scan_order_preparation_code($1,$2,$3,$4)', [orderId, `BAR-${orderId}`, actor, key()])
      await db.query('select set_order_package_parcels($1,1,$2,$3)', [orderId, actor, key()])
      await db.query('select confirm_local_delivery_parcel($1,$2,$3)', [orderId, `BX-PKG-${1000 + orderId}-01`, actor])
      return orderId
    }
    const markInTransit = (client, orderId) => client.query('select id from mark_local_delivery_in_transit($1,$2,$3)', [orderId, 'pagado', actor])
    const estado = async (orderId) => (await db.query('select estado from ordenes where id=$1', [orderId])).rows[0].estado

    await t.test('rearmado en curso: En camino espera el lock y, al liberarse, ve el armado nuevo => 0 filas, sigue Preparando', async () => {
      const orderId = await readyOrder()
      await a.query('begin')
      await a.query('select reset_order_preparation($1,$2,$3,$4)', [orderId, actor, key(), 'Rearmado por caja dañada'])
      const marking = settle(markInTransit(b, orderId))
      await pause(300)
      await a.query('commit')
      const outcome = await marking
      assert.ok(outcome.ok, outcome.error?.message)
      assert.deepEqual(outcome.value.rows, [], 'no avanza con el snapshot anterior al rearmado')
      assert.equal(await estado(orderId), 'pagado')
    })

    await t.test('rearmado con otra cantidad de bultos confirmado mientras En camino espera => 0 filas', async () => {
      const orderId = await readyOrder()
      await a.query('begin')
      await a.query('select reset_order_preparation($1,$2,$3,$4)', [orderId, actor, key(), 'Rearmado con dos cajas'])
      await a.query('select scan_order_preparation_code($1,$2,$3,$4)', [orderId, `BAR-${orderId}`, actor, key()])
      await a.query('select set_order_package_parcels($1,2,$2,$3)', [orderId, actor, key()])
      const marking = settle(markInTransit(b, orderId))
      await pause(300)
      await a.query('commit')
      const outcome = await marking
      assert.ok(outcome.ok, outcome.error?.message)
      assert.deepEqual(outcome.value.rows, [])
      assert.equal(await estado(orderId), 'pagado')
    })

    await t.test('En camino primero: el rearmado espera y después se rechaza (el pedido ya salió)', async () => {
      const orderId = await readyOrder()
      await a.query('begin')
      assert.equal((await markInTransit(a, orderId)).rows.length, 1)
      const resetting = settle(b.query('select reset_order_preparation($1,$2,$3,$4)', [orderId, actor, key(), 'Rearmado tardío del pedido']))
      await pause(300)
      await a.query('commit')
      const outcome = await resetting
      assert.equal(outcome.ok, false)
      assert.match(outcome.error.message, /DISPATCH_LOCAL_ALREADY_DISPATCHED/)
      assert.equal(await estado(orderId), 'en_camino')
    })

    await t.test('dos operadores marcan En camino a la vez: uno solo escribe', async () => {
      const orderId = await readyOrder()
      const results = await Promise.all([markInTransit(a, orderId), markInTransit(b, orderId)])
      assert.deepEqual(results.map((result) => result.rows.length).sort(), [0, 1])
      assert.equal(await estado(orderId), 'en_camino')
    })

    await t.test('código anterior con A: su UPDATE directo sigue funcionando (sin guarda global todavía)', async () => {
      const orderId = ++nextOrder
      await db.query("insert into ordenes(id,shipping_provider,andreani_envio_id,andreani_creation_status) values ($1,'beyonix',null,null)", [orderId])
      const legacy = await a.query("update ordenes set estado='en_camino' where id=$1 and estado='pagado' and shipping_provider='beyonix' and financial_status='payment_confirmed' and cancelled_at is null returning id", [orderId])
      assert.equal(legacy.rows.length, 1)
    })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
