import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// I: el cliente cancela justo mientras el operador confirma el QR final del
// Bulto, con conexiones PostgreSQL REALES. Resultado determinista: gana la
// primera que toma el pedido; nunca quedan aceptadas las dos. Mismas
// migraciones que bundle-handover-cancellation-db.test.ts.

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const between = (path, start, end) => {
  const text = read(path)
  const from = text.indexOf(start)
  return text.slice(from, text.indexOf(end, from))
}
const SETUP = [
  'lib/orders/fixtures/dispatch-schema.sql',
  'lib/orders/fixtures/bundle-handover-orders.sql',
  'supabase/migrations/20260820120000_cost_catalog_barcode.sql',
  'supabase/migrations/20261005100000_dispatch_operations.sql',
  'supabase/migrations/20261005110000_dispatch_guards.sql',
  'supabase/migrations/20261007100000_barcodes_parcels_dispatch.sql',
  'lib/orders/fixtures/dispatch-inventory-schema.sql',
  'lib/orders/fixtures/bundle-handover-finance.sql',
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
  'supabase/migrations/20261016170000_dispatch_batch_display_numbers.sql',
  'supabase/migrations/20261017100000_dispatch_finalize_on_verification.sql',
  'supabase/migrations/20261017110000_super_admin_force_cancellation.sql',
  'supabase/migrations/20261018120000_dispatch_mobile_final_control.sql',
  'supabase/migrations/20261021100000_dispatch_andreani_label_scan_confirmation.sql',
  'supabase/migrations/20260917110000_fix_customer_cancellation_type_and_null_bugs.sql',
]
const REPLACED = [
  between('supabase/migrations/20260916100000_block_cancellation_during_andreani_creation.sql', 'create or replace function public.approve_order_claim_cancellation(', 'revoke all on function public.approve_order_claim_cancellation'),
  between('supabase/migrations/20260916100000_block_cancellation_during_andreani_creation.sql', 'create or replace function public.admin_cancel_order(', 'revoke all on function public.admin_cancel_order'),
  between('supabase/migrations/20261014140000_automatic_cancellation_fiscal_refund.sql', 'create or replace function public.begin_mercadopago_order_refund(', 'revoke all on function public.begin_mercadopago_order_refund'),
]
const actor = '20000000-0000-4000-8000-000000000002'
const customer = '10000000-0000-4000-8000-000000000001'
let requestNumber = 0
const key = () => `92000000-0000-4000-8000-${String(++requestNumber).padStart(12, '0')}`
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const label = (orderId) => `360000${String(orderId).padStart(6, '0')}`

test('I: cancelación del cliente y QR final del Bulto al mismo tiempo: gana una sola', { timeout: 240000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-bundle-handover-pg')
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
    for (const file of SETUP) await db.query(read(file))
    for (const sql of REPLACED) await db.query(sql)
    await db.query(read('supabase/migrations/20261023100000_bundle_handover_cancellation_cutoff.sql'))
    await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
    await db.query("insert into productos(id,sku,codigo_barra,nombre) values (1,'SKU-A','BAR-A','Producto de prueba')")
    await db.query("insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ('SKU-A',1,null)")
    await db.query('insert into product_cost_entries(product_id,received_quantity) values (1,50)')
    const a = await connect(); const b = await connect()

    let nextOrder = 1200
    // Pedido preparado, con etiqueta Andreani confirmada, solo en un Bulto finalizado.
    const bundledOrder = async () => {
      const orderId = ++nextOrder
      await db.query(`insert into ordenes(id,usuario_id,andreani_envio_id,andreani_tracking,andreani_bulto_numbers) values ($1,$2,$3,$4,$5)`,
        [orderId, customer, `ENV-${orderId}`, label(orderId), [label(orderId)]])
      await db.query('insert into orden_items(id,orden_id,producto_id,cantidad) values ($1,$1,1,1)', [orderId])
      await db.query('select refresh_inventory_stock(1)')
      await db.query('select begin_order_preparation($1,$2)', [orderId, actor])
      await db.query('select scan_order_preparation_code($1,$2,$3,$4)', [orderId, 'BAR-A', actor, key()])
      await db.query('select confirm_order_andreani_label($1,$2,$3)', [orderId, label(orderId), actor])
      const batch = (await db.query('select (create_dispatch_batch_with_orders($1,$2,$3)).*', [actor, key(), [orderId]])).rows[0]
      await db.query("select verify_and_finalize_dispatch_batch($1,$2,'scanner',$3,$4,null)", [batch.id, label(orderId), actor, key()])
      return { orderId, batch }
    }
    const cancel = (client, orderId) => client.query('select request_customer_order_cancellation_with_claim($1,$2,$3) r', [orderId, customer, 'Me arrepentí de la compra'])
    const handover = (client, batch) => client.query('select confirm_dispatch_batch_handover($1,$2,$3) r', [batch.id, batch.code, actor])
    const state = async (orderId, batchId) => (await db.query(`select o.estado, o.andreani_handed_over_at is not null handed, b.status,
      (select count(*)::int from order_cancellation_holds h where h.order_id=o.id and h.resolved_at is null) holds
      from ordenes o, dispatch_batches b where o.id=$1 and b.id=$2`, [orderId, batchId])).rows[0]

    await t.test('el QR final toma el pedido primero: la cancelación espera y se rechaza', async () => {
      const { orderId, batch } = await bundledOrder()
      await a.query('begin')
      await handover(a, batch)
      const cancelling = settle(cancel(b, orderId))
      await pause(300)
      await a.query('commit')
      const outcome = await cancelling
      assert.equal(outcome.ok, false)
      assert.match(outcome.error.message, /ORDER_ALREADY_DISPATCHED/)
      assert.deepEqual(await state(orderId, batch.id), { estado: 'pagado', handed: true, status: 'handed_over', holds: 0 })
    })

    await t.test('la cancelación toma el pedido primero: el QR final espera y no entrega el Bulto', async () => {
      const { orderId, batch } = await bundledOrder()
      await b.query('begin')
      await cancel(b, orderId)
      const handing = settle(handover(a, batch))
      await pause(300)
      await b.query('commit')
      const outcome = await handing
      assert.equal(outcome.ok, false)
      assert.match(outcome.error.message, /DISPATCH_ORDER_BLOCKED/)
      assert.deepEqual(JSON.parse(outcome.error.detail).map((issue) => issue.orderId), [orderId])
      assert.deepEqual(await state(orderId, batch.id), { estado: 'cancelado', handed: false, status: 'closed', holds: 1 })
    })

    await t.test('a la vez: exactamente una gana y nunca quedan aceptadas las dos', async () => {
      for (let round = 0; round < 6; round += 1) {
        const { orderId, batch } = await bundledOrder()
        const [cancelled, handed] = await Promise.all([settle(cancel(a, orderId)), settle(handover(b, batch))])
        assert.equal(Number(cancelled.ok) + Number(handed.ok), 1, `ronda ${round}: ${cancelled.error?.message ?? ''} ${handed.error?.message ?? ''}`)
        const current = await state(orderId, batch.id)
        assert.ok(!(current.estado === 'cancelado' && current.handed), 'nunca un cancelado entregado')
        assert.equal(current.estado === 'cancelado', cancelled.ok)
        assert.equal(current.handed, handed.ok)
      }
    })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
