import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Regresión del pedido real por transferencia (2026-09-29): la transferencia
// coincidía, pero vender la ÚLTIMA unidad hacía fallar el COMMIT de
// confirm_transfer_auto_verification ("La variante necesita stock asignado.")
// porque los requisitos de ACTIVACIÓN (stock > 0) se re-evaluaban como
// invariante en constraint triggers diferidos. PostgreSQL real con conexiones
// concurrentes, stock derivado real (refresh_inventory_stock + triggers de
// órdenes) y las reglas comerciales reales, apiladas en el orden de producción.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const extract = (path, pattern) => {
  const match = read(path).match(pattern)?.[0]
  assert.ok(match, `no se encontró la función en ${path}`)
  return match
}
const release = extract('../../supabase/migrations/20260801095000_stock_reservations.sql',
  /create or replace function public\.release_order_stock_reservation\([\s\S]*?\n\$\$;/)
const physicalGuard = extract('../../supabase/migrations/20260730174000_sellable_conditioned_variants.sql',
  /create or replace function public\.validate_inventory_order_confirmation\(\)[\s\S]*?\n\$\$;/)

const BASE_MIGRATIONS = [
  '../../supabase/migrations/20260918100000_refresh_inventory_stock_fail_closed.sql',
  '../../supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql',
  '../../supabase/migrations/20260918120000_stock_nonnegative_check_constraint.sql',
  '../inventory/fixtures/inventory-hardening-views.sql',
  '../inventory/fixtures/inventory-hardening-functions.sql',
  '../../supabase/migrations/20260808210000_product_activation_requirements.sql',
  '../../supabase/migrations/20260820170000_variant_activation_uses_real_stock.sql',
  '../../supabase/migrations/20260925120000_checkout_step_stock_reservations.sql',
  '../../supabase/migrations/20260925130000_mercadopago_checkout_reservation_commit.sql',
  '../../supabase/migrations/20260913120000_transfer_auto_verification.sql',
  '../../supabase/migrations/20260914090000_transfer_auto_verification_amount_lock_and_stock_claim.sql',
  '../../supabase/migrations/20260914100000_transfer_verification_lease_and_payment_claims.sql',
  '../../supabase/migrations/20260926100000_transfer_checkout_reservation_window.sql',
  '../../supabase/migrations/20260926110000_retire_legacy_30_minute_checkout_reservation.sql',
  '../../supabase/migrations/20260926120000_transfer_payment_after_cancellation.sql',
]
const FIX_MIGRATION = '../../supabase/migrations/20261001140000_stock_required_only_on_activation.sql'

test('última unidad: confirmar una transferencia que agota el stock (PostgreSQL real)', { timeout: 240000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-last-unit')
  const clients = []
  const connect = async () => {
    const client = server.getPgClient('postgres', '127.0.0.1')
    await client.connect(); clients.push(client)
    await client.query("set request.jwt.claim.role = 'service_role'")
    await client.query("set statement_timeout = '15s'")
    return client
  }
  try {
    await server.initialise(); await server.start()
    const db = await connect()
    await db.query(read('../inventory/fixtures/inventory-hardening-schema.sql'))
    await db.query(`alter table productos
      add column nombre text, add column sku text, add column precio numeric, add column categoria_id bigint,
      add column descripcion text, add column peso_empaquetado_kg numeric, add column alto_paquete_cm numeric,
      add column ancho_paquete_cm numeric, add column largo_paquete_cm numeric`)
    await db.query(`alter table producto_variantes
      add column nombre text, add column sku text, add column color_hex text,
      add column imagenes jsonb not null default '[]'::jsonb, add column orden integer not null default 0`)
    await db.query('alter table inventory_variant_allocations add column product_id bigint')
    await db.query('create table categorias (id bigint primary key)')
    await db.query(`create table producto_especificaciones (
      id bigint generated always as identity primary key, producto_id bigint not null references productos(id),
      activo boolean not null default true, icono text, texto text)`)
    await db.query(`alter table ordenes
      add column payment_method_id text, add column payment_confirmed_at timestamptz,
      add column cliente_email text, add column cliente_nombre text, add column financial_status text,
      add column total numeric, add column external_amount_due numeric, add column paid_at timestamptz,
      add column payment_confirmed_by uuid, add column payment_confirmed_amount numeric,
      add column order_change_status text, add column order_change_extra_amount numeric,
      add column cancelled_at timestamptz, add column refund_pending_at timestamptz`)
    await db.query('alter table order_audit_events add column previous_status text, add column new_status text')
    await db.query("create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$")
    await db.query('create function public.complete_cart_stock_reservation(text,bigint) returns void language sql as $$ select $$')
    await db.query("create function public.validate_checkout_inventory_reservation(jsonb,text,bigint) returns jsonb language sql as $$ select '{}'::jsonb $$")
    await db.query(release)
    await db.query('create trigger release_order_stock_reservation after update of estado, payment_status or delete on ordenes for each row execute function public.release_order_stock_reservation()')
    await db.query(physicalGuard)
    await db.query('create trigger validate_inventory_order_confirmation before update of estado, payment_status on ordenes for each row execute function public.validate_inventory_order_confirmation()')
    await db.query('insert into categorias(id) values (1)')
    for (const migration of BASE_MIGRATIONS) await db.query(read(migration))

    const a = await connect(); const b = await connect()
    let sequence = 0
    /** Producto activo y completo con UNA variante principal y `stock` unidades compradas. */
    const product = async (stock) => {
      const n = ++sequence
      const productId = Number((await db.query(`insert into productos(activo,nombre,sku,precio,categoria_id,descripcion,
        peso_empaquetado_kg,alto_paquete_cm,ancho_paquete_cm,largo_paquete_cm)
        values(false,$1,$2,900,1,'Descripción',1,1,1,1) returning id`, [`Producto ${n}`, `SKU-${n}`])).rows[0].id)
      await db.query("insert into producto_especificaciones(producto_id,icono,texto) values($1,'box','Caja')", [productId])
      const variantId = Number((await db.query(`insert into producto_variantes(producto_id,activo,nombre,sku,color_hex,imagenes,orden)
        values($1,false,'Negro',$2,'#000000','["https://example.com/a.png"]'::jsonb,1) returning id`, [productId, `SKU-${n}-N`])).rows[0].id)
      if (stock > 0) {
        await db.query('insert into product_cost_entries(product_id,variant_id,received_quantity) values($1,$2,$3)', [productId, variantId, stock])
      }
      await db.query('select refresh_inventory_stock($1)', [productId])
      if (stock > 0) await db.query('update productos set activo=true where id=$1', [productId])
      return { productId, variantId }
    }
    const order = async (p, quantity = 1) => {
      const id = Number((await db.query(`insert into ordenes(payment_method_id,payment_status,total,external_amount_due,cliente_email)
        values('transferencia','pendiente_comprobante',900,900,'cliente@example.com') returning id`)).rows[0].id)
      await db.query('insert into orden_items(orden_id,producto_id,variante_id,cantidad) values($1,$2,$3,$4)', [id, p.productId, p.variantId, quantity])
      return id
    }
    let paymentSequence = 0
    const claim = async (client, orderId) => (await client.query(
      'select transfer_verification_lease_id from claim_transfer_verification_attempt($1)', [orderId])).rows[0].transfer_verification_lease_id
    const confirm = async (client, orderId, lease, paymentId = `pay-${++paymentSequence}`) => (await client.query(
      `select estado, payment_status, transfer_verification_status from confirm_transfer_auto_verification(
        $1,$2,'money_transfer','account_money',900,'CUIL','20301112220','30111222',null,now(),now(),$3)`,
      [orderId, paymentId, lease])).rows[0]
    const variant = async (p) => (await db.query('select activo, stock from producto_variantes where id=$1', [p.variantId])).rows[0]
    const productRow = async (p) => (await db.query('select activo, stock from productos where id=$1', [p.productId])).rows[0]
    const orderRow = async (id) => (await db.query(
      'select estado, payment_status, transfer_verification_status, transfer_matched_payment_id from ordenes where id=$1', [id])).rows[0]
    const claims = async (id) => Number((await db.query('select count(*) from transfer_verification_payment_claims where order_id=$1', [id])).rows[0].count)

    await t.test('bug reproducido (reglas previas): la última unidad hacía fallar el COMMIT y revertía la venta', async () => {
      const p = await product(1)
      const id = await order(p)
      const lease = await claim(a, id)
      await assert.rejects(confirm(a, id, lease, 'pay-legacy'), /La variante (principal )?necesita stock asignado\./)
      assert.equal((await orderRow(id)).payment_status, 'pendiente_comprobante', 'rollback completo')
      assert.equal((await variant(p)).stock, 1)
      assert.equal(await claims(id), 0, 'ni siquiera el claim del payment.id sobrevivía')
    })

    await db.query(read(FIX_MIGRATION))

    await t.test('A/B/F. stock 1 -> confirmar 1 -> OK, stock 0, sin "necesita stock asignado"; producto y variante siguen activos (Sin stock)', async () => {
      const p = await product(1)
      const id = await order(p)
      const confirmed = await confirm(a, id, await claim(a, id), 'pay-last-unit')
      assert.deepEqual(confirmed, { estado: 'pagado', payment_status: 'confirmado', transfer_verification_status: 'auto_verified' })
      assert.deepEqual(await variant(p), { activo: true, stock: 0 })
      assert.deepEqual(await productRow(p), { activo: true, stock: 0 })
      const row = await orderRow(id)
      assert.equal(row.transfer_matched_payment_id, 'pay-last-unit')
      assert.equal(await claims(id), 1)
      const audit = (await db.query("select count(*) from order_audit_events where order_id=$1 and action='transfer_auto_verified'", [id])).rows[0].count
      assert.equal(Number(audit), 1)
    })

    await t.test('C. idempotente: reintentos y clicks repetidos no confirman ni descuentan dos veces', async () => {
      const p = await product(1)
      const id = await order(p)
      const lease = await claim(a, id)
      await confirm(a, id, lease, 'pay-idem')
      await assert.rejects(confirm(b, id, lease, 'pay-idem'), /ALREADY_RESOLVED/)
      await assert.rejects(claim(b, id), /ALREADY_RESOLVED/)
      assert.deepEqual(await variant(p), { activo: true, stock: 0 })
      assert.equal(await claims(id), 1)
      const audits = (await db.query("select count(*) from order_audit_events where order_id=$1 and action='transfer_auto_verified'", [id])).rows[0].count
      assert.equal(Number(audits), 1)
    })

    await t.test('D. dos confirmaciones concurrentes por la última unidad: una confirma, la otra conflicto de stock; nunca negativo', async () => {
      const p = await product(1)
      const first = await order(p); const second = await order(p)
      const [leaseA, leaseB] = [await claim(a, first), await claim(b, second)]
      const results = await Promise.allSettled([confirm(a, first, leaseA, 'pay-race-a'), confirm(b, second, leaseB, 'pay-race-b')])
      assert.ok(results.every((result) => result.status === 'fulfilled'), JSON.stringify(results.map((r) => r.reason?.message)))
      const statuses = results.map((result) => result.value.payment_status).sort()
      assert.deepEqual(statuses, ['auto_verified_stock_conflict', 'confirmado'])
      assert.deepEqual(await variant(p), { activo: true, stock: 0 })
      assert.equal((await productRow(p)).stock, 0)
    })

    await t.test('D. la misma orden confirmada en paralelo con el mismo lease: un solo consumo', async () => {
      const p = await product(1)
      const id = await order(p)
      const lease = await claim(a, id)
      const results = await Promise.allSettled([confirm(a, id, lease, 'pay-same'), confirm(b, id, lease, 'pay-same')])
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
      assert.match(results.find((result) => result.status === 'rejected').reason.message, /ALREADY_RESOLVED|INVALID_VERIFICATION_STATE/)
      assert.deepEqual(await variant(p), { activo: true, stock: 0 })
      assert.equal(await claims(id), 1)
    })

    await t.test('E. activar sigue exigiendo stock y datos; una variante activa agotada no puede perder su SKU', async () => {
      await assert.rejects(product(0).then((p) => db.query('update productos set activo=true where id=$1', [p.productId])),
        /necesita stock asignado/, 'activar un producto sin stock sigue bloqueado')
      const p = await product(2)
      const extra = Number((await db.query(`insert into producto_variantes(producto_id,activo,nombre,sku,color_hex,imagenes,orden)
        values($1,false,'Blanco','SKU-X','#FFFFFF','["https://example.com/b.png"]'::jsonb,2) returning id`, [p.productId])).rows[0].id)
      await assert.rejects(db.query('update producto_variantes set activo=true where id=$1', [extra]),
        /La variante necesita stock asignado\./, 'activar una variante sin stock sigue bloqueado')
      await assert.rejects(db.query(`insert into producto_variantes(producto_id,activo,nombre,sku,color_hex,imagenes,orden)
        values($1,true,'Rojo','SKU-R','#FF0000','["https://example.com/c.png"]'::jsonb,3)`, [p.productId]),
      /La variante necesita stock asignado\./, 'alta ya activa sin stock sigue bloqueada')

      const soldOut = await product(1)
      const id = await order(soldOut)
      await confirm(a, id, await claim(a, id), 'pay-sold-out')
      await db.query("update producto_variantes set nombre='Negro mate' where id=$1", [soldOut.variantId])
      await assert.rejects(db.query('update producto_variantes set sku=null where id=$1', [soldOut.variantId]),
        /necesita un SKU/, 'el resto de los requisitos sigue siendo un invariante')
    })

    await t.test('tipificado: un catálogo inválido al confirmar es CATALOG_STATE_INVALID y revierte todo (sin commits parciales)', async () => {
      const p = await product(1)
      const id = await order(p)
      await db.query('alter table producto_variantes disable trigger validate_variant_commercial_state')
      await db.query('update producto_variantes set sku=null where id=$1', [p.variantId])
      await db.query('alter table producto_variantes enable trigger validate_variant_commercial_state')
      const lease = await claim(a, id)
      await assert.rejects(confirm(a, id, lease, 'pay-invalid-catalog'), (error) => /^CATALOG_STATE_INVALID: La variante (principal )?necesita un SKU\./.test(error.message))
      assert.equal((await orderRow(id)).payment_status, 'pendiente_comprobante')
      assert.equal((await variant(p)).stock, 1)
      assert.equal(await claims(id), 0)
      // La conexión sigue usable y los demás constraints diferidos conservan su modo.
      const deferred = (await a.query(`select count(*) from pg_trigger where tgname in
        ('validate_product_commercial_state','validate_variant_commercial_state') and tginitdeferred`)).rows[0].count
      assert.equal(Number(deferred), 2)
    })

    await t.test('código de barra: obligatorio al ACTIVAR, nunca rompe variantes activas legacy ni la venta', async () => {
      const legacy = await product(1)
      await db.query(read('../../supabase/migrations/20260820120000_cost_catalog_barcode.sql'))
      await db.query(extract('../../supabase/migrations/20261007100000_barcodes_parcels_dispatch.sql',
        /create or replace function public\.product_variant_listing_error\([\s\S]*?\n\$\$;/))
      const id = await order(legacy)
      await confirm(a, id, await claim(a, id), 'pay-legacy-no-barcode')
      assert.deepEqual(await variant(legacy), { activo: true, stock: 0 })
      await db.query("update producto_variantes set nombre='Negro brillante' where id=$1", [legacy.variantId])

      await assert.rejects(product(1), /necesita un código de barra/)
      const pending = Number((await db.query("select id from productos where activo=false order by id desc limit 1")).rows[0].id)
      const pendingVariant = Number((await db.query('select id from producto_variantes where producto_id=$1', [pending])).rows[0].id)
      await db.query("update producto_variantes set codigo_barra='7790001000017' where id=$1", [pendingVariant])
      await db.query('update productos set activo=true where id=$1', [pending])
      assert.equal((await db.query('select activo from productos where id=$1', [pending])).rows[0].activo, true)
    })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
