import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Envío BEYONIX con conexiones PostgreSQL REALES y simultáneas.
// 1. "Preparando → En camino" sólo con la migración A (antes de B): el código
//    nuevo es seguro por sí mismo. Un rearmado o un cambio de bultos que se
//    confirma mientras la RPC espera el lock nunca deja pasar el snapshot viejo.
// 2. Con A+B+C: un cambio de pedido (order_change_status) confirmado mientras
//    En camino espera el lock lo frena, y un rearmado confirmado mientras se
//    registra la generación de etiquetas invalida las del intento anterior.

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
const MIGRATIONS_B_C = [
  'supabase/migrations/20261103130000_local_delivery_in_transit_parcels_guard.sql',
  'supabase/migrations/20261104120000_local_delivery_change_guard_and_label_generation.sql',
]
const actor = '20000000-0000-4000-8000-000000000002'
let requestNumber = 0
const key = () => `72000000-0000-4000-8000-${String(++requestNumber).padStart(12, '0')}`
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Cluster aislado con la base `beyonix` armada con `files`; `run` recibe la conexión principal y dos más. */
async function withIsolatedDatabase(prefix, files, run) {
  const { server, databaseDir } = await createIsolatedPostgres(prefix)
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
    for (const file of files) {
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
    await run({ db, a, b })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
}

function orderHelpers(db) {
  let nextOrder = 1200
  // Pedido local pickeado con `parcels` bultos definidos (confirmados si `confirmed`).
  const readyOrder = async ({ parcels = 1, confirmed = true } = {}) => {
    const orderId = ++nextOrder
    await db.query(`insert into productos(id,sku,codigo_barra,nombre) values ($1,$2,$3,'Producto de prueba')`, [orderId, `SKU-${orderId}`, `BAR-${orderId}`])
    await db.query('insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ($1,$2,null)', [`SKU-${orderId}`, orderId])
    await db.query('insert into product_cost_entries(product_id,received_quantity) values ($1,5)', [orderId])
    await db.query("insert into ordenes(id,shipping_provider,andreani_envio_id,andreani_creation_status) values ($1,'beyonix',null,null)", [orderId])
    await db.query('insert into orden_items(id,orden_id,producto_id,cantidad) values ($1,$1,$1,1)', [orderId])
    await db.query('select refresh_inventory_stock($1)', [orderId])
    await db.query('select begin_order_preparation($1,$2)', [orderId, actor])
    await db.query('select scan_order_preparation_code($1,$2,$3,$4)', [orderId, `BAR-${orderId}`, actor, key()])
    await db.query('select set_order_package_parcels($1,$2,$3,$4)', [orderId, parcels, actor, key()])
    if (confirmed) {
      for (let index = 1; index <= parcels; index += 1) {
        await db.query('select confirm_local_delivery_parcel($1,$2,$3)', [orderId, `BX-PKG-${1000 + orderId}-${String(index).padStart(2, '0')}`, actor])
      }
    }
    return orderId
  }
  const markInTransit = (client, orderId) => client.query('select id from mark_local_delivery_in_transit($1,$2,$3)', [orderId, 'pagado', actor])
  const estado = async (orderId) => (await db.query('select estado from ordenes where id=$1', [orderId])).rows[0].estado
  return { readyOrder, markInTransit, estado }
}

test('En camino BEYONIX con A (sin B): rearmado y cambios de bultos concurrentes nunca avanzan con un snapshot viejo', { timeout: 240000 }, async (t) => {
  await withIsolatedDatabase('beyonix-local-in-transit-pg', SETUP, async ({ db, a, b }) => {
    const { readyOrder, markInTransit, estado } = orderHelpers(db)

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
      const orderId = 1199
      await db.query("insert into ordenes(id,shipping_provider,andreani_envio_id,andreani_creation_status) values ($1,'beyonix',null,null)", [orderId])
      const legacy = await a.query("update ordenes set estado='en_camino' where id=$1 and estado='pagado' and shipping_provider='beyonix' and financial_status='payment_confirmed' and cancelled_at is null returning id", [orderId])
      assert.equal(legacy.rows.length, 1)
    })
  })
})

test('Envío BEYONIX con A+B+C: cambios de pedido y rearmados concurrentes nunca dejan pasar un estado o etiquetas viejas', { timeout: 240000 }, async (t) => {
  await withIsolatedDatabase('beyonix-local-c-pg', [...SETUP, ...MIGRATIONS_B_C], async ({ db, a, b }) => {
    const { readyOrder, markInTransit, estado } = orderHelpers(db)
    const actions = async (orderId) => (await db.query('select action from order_audit_events where order_id=$1 order by id', [orderId])).rows.map((row) => row.action)
    const packageOf = async (orderId) => (await db.query('select id, attempt_number from order_packages where order_id=$1', [orderId])).rows[0]
    const recordGenerated = (client, orderId, pkg, barcodes) =>
      client.query('select record_local_delivery_labels_generated($1,$2,$3,$4,$5) result', [orderId, actor, pkg.id, pkg.attempt_number, barcodes])

    // Bloqueantes reales del sistema (dispatch_order_block_reasons 'change', ARCA y el servicio): no hay otros.
    for (const status of ['change_requested', 'extra_payment_pending']) {
      await t.test(`${status} confirmado mientras En camino espera el lock => 0 filas, sigue Preparando, 0 efectos`, async () => {
        const orderId = await readyOrder()
        // El servicio leyó el pedido válido (sin cambio pendiente)...
        assert.equal((await db.query('select order_change_status from ordenes where id=$1', [orderId])).rows[0].order_change_status, null)
        const before = await actions(orderId)
        // ...otra conexión pide el cambio y retiene el lock de la fila...
        await a.query('begin')
        await a.query('update ordenes set order_change_status=$2 where id=$1', [orderId, status])
        // ...y la RPC de En camino espera ese lock.
        const marking = settle(markInTransit(b, orderId))
        await pause(300)
        await a.query('commit')
        const outcome = await marking
        assert.ok(outcome.ok, outcome.error?.message)
        assert.deepEqual(outcome.value.rows, [], `${status}: no avanza`)
        assert.equal(await estado(orderId), 'pagado')
        assert.deepEqual(await actions(orderId), before, `${status}: 0 efectos`)
      })
    }

    await t.test('En camino primero: el cambio pedido después espera y se aplica sobre el pedido ya En camino (serializado, sin estado intermedio)', async () => {
      const orderId = await readyOrder()
      await a.query('begin')
      assert.equal((await markInTransit(a, orderId)).rows.length, 1)
      const changing = settle(b.query("update ordenes set order_change_status='change_requested' where id=$1 returning estado", [orderId]))
      await pause(300)
      await a.query('commit')
      const outcome = await changing
      assert.ok(outcome.ok, outcome.error?.message)
      assert.equal(outcome.value.rows[0].estado, 'en_camino', 'el cambio ve el estado ya confirmado')
    })

    await t.test('rearmado confirmado mientras se registra la generación de etiquetas => DISPATCH_PARCEL_STALE, 0 eventos', async () => {
      const orderId = await readyOrder({ parcels: 2, confirmed: false })
      const pkg = await packageOf(orderId)
      const stale = [`BX-PKG-${1000 + orderId}-01`, `BX-PKG-${1000 + orderId}-02`]
      await a.query('begin')
      await a.query('select reset_order_preparation($1,$2,$3,$4)', [orderId, actor, key(), 'Rearmado por caja dañada'])
      await a.query('select scan_order_preparation_code($1,$2,$3,$4)', [orderId, `BAR-${orderId}`, actor, key()])
      await a.query('select set_order_package_parcels($1,1,$2,$3)', [orderId, actor, key()])
      const generating = settle(recordGenerated(b, orderId, pkg, stale))
      await pause(300)
      await a.query('commit')
      const outcome = await generating
      assert.equal(outcome.ok, false, 'la etiqueta del intento viejo no se devuelve como válida')
      assert.match(outcome.error.message, /DISPATCH_PARCEL_STALE/)
      assert.equal((await actions(orderId)).includes('local_delivery_labels_generated'), false)
      const current = await packageOf(orderId)
      const fresh = await recordGenerated(db, orderId, current, [`BX-PKG-${1000 + orderId}-R2-01`])
      assert.deepEqual([fresh.rows[0].result.attempt, fresh.rows[0].result.reprint], [2, false], 'el intento vigente sí se genera')
    })

    await t.test('generación primero: el rearmado espera; las etiquetas devueltas eran del intento vigente y después quedan vencidas', async () => {
      const orderId = await readyOrder({ parcels: 1, confirmed: false })
      const pkg = await packageOf(orderId)
      const codes = [`BX-PKG-${1000 + orderId}-01`]
      await a.query('begin')
      const generated = await recordGenerated(a, orderId, pkg, codes)
      assert.equal(generated.rows[0].result.attempt, 1)
      const resetting = settle(b.query('select reset_order_preparation($1,$2,$3,$4)', [orderId, actor, key(), 'Rearmado por caja dañada']))
      await pause(300)
      await a.query('commit')
      assert.ok((await resetting).ok)
      await assert.rejects(recordGenerated(db, orderId, pkg, codes), /DISPATCH_PARCEL_STALE/, 'regenerar el intento viejo ya no se permite')
      await assert.rejects(db.query('select confirm_local_delivery_parcel($1,$2,$3)', [orderId, codes[0], actor]), /DISPATCH_(PARCEL_STALE|PACKAGE_NOT_PREPARED)/, 'ni confirmarla físicamente')
    })

    await t.test('dos generaciones simultáneas del mismo intento: exactamente una es la primera', async () => {
      const orderId = await readyOrder({ parcels: 1, confirmed: false })
      const pkg = await packageOf(orderId)
      const codes = [`BX-PKG-${1000 + orderId}-01`]
      const results = await Promise.all([recordGenerated(a, orderId, pkg, codes), recordGenerated(b, orderId, pkg, codes)])
      assert.deepEqual(results.map((result) => result.rows[0].result.reprint).sort(), [false, true])
    })
  })
})
