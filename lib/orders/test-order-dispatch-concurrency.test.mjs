import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'
import { OWNER, SETUP } from './fixtures/test-order-classification-db.mjs'

// PostgreSQL real con conexiones concurrentes: clasificación de una compra de
// prueba (20261124120000, función REAL) contra las operaciones de Despachos
// que 20261125150000 protege en la base: etiquetas BEYONIX (token del QR y
// registro de la generación) e inicio de garantía (efecto del cron
// local-delivery-effects). Una transacción toma sus locks y queda abierta; la
// otra se lanza, se verifica que ESPERA y, al confirmar la primera, termina
// sin deadlock: nada nuevo después de una clasificación confirmada.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function extractFunction(source, name) {
  const start = source.indexOf(`create or replace function public.${name}(`)
  if (start < 0) throw new Error(`No se encontró ${name}`)
  const body = source.indexOf('$$', start) + 2
  return source.slice(start, source.indexOf('$$;', body) + 3)
}
const DISPATCH_OPS = read('../../supabase/migrations/20261005100000_dispatch_operations.sql')
const DISPATCH_GUARDS = read('../../supabase/migrations/20261005110000_dispatch_guards.sql')
const CARRIER = read('../../supabase/migrations/20261106110000_dispatch_records_carrier_filter.sql')
const OUTCOMES = read('../../supabase/migrations/20261105120000_local_delivery_outcomes_and_returns.sql')
const MIGRATION = read('../../supabase/migrations/20261125150000_exclude_test_orders_from_dispatch.sql')

// Lo mínimo de Despachos / Envío BEYONIX que usan las funciones reales.
const DISPATCH_SCHEMA = `
  alter table public.ordenes add column if not exists shipping_provider text, add column if not exists envio_proveedor text,
    add column if not exists cancelled_at timestamptz, add column if not exists delivered_at timestamptz;
  alter table public.orden_items add column if not exists warranty_started_at timestamptz, add column if not exists warranty_expires_at timestamptz,
    add column if not exists warranty_status text, add column if not exists warranty_months integer;
  alter table public.local_delivery_return_reservations add column if not exists shipment_id bigint;
  create table public.order_packages (id bigint primary key, order_id bigint not null unique, status text not null, attempt_number integer not null,
    parcel_count integer, parcels_defined_at timestamptz);
  create table public.order_package_parcels (id bigserial primary key, package_id bigint not null, attempt_number integer not null,
    parcel_count integer not null, parcel_index integer not null, barcode text not null);
  create table public.local_delivery_shipments (id bigserial primary key, order_id bigint not null, shipment_number integer not null default 1,
    access_token text not null, token_revoked_at timestamptz, outcome_status text not null default 'pending', returned_at timestamptz,
    created_by uuid, updated_at timestamptz);
  ${extractFunction(DISPATCH_OPS, 'assert_dispatch_operator')}
  ${extractFunction(CARRIER, 'order_shipping_carrier')}
  ${extractFunction(CARRIER, 'order_is_local_delivery')}
  ${extractFunction(OUTCOMES, 'local_delivery_current_shipment_id')}
  ${extractFunction(DISPATCH_GUARDS, 'lock_item_order_for_dispatch')}
  create trigger lock_item_order_for_dispatch before insert or delete or update on public.orden_items
    for each row execute function public.lock_item_order_for_dispatch();
  -- BX-1019 / BX-1020 (Envío BEYONIX entregados, armados) y BX-1021 real.
  update public.ordenes set shipping_provider = 'beyonix', delivered_at = now() where id in (19, 20, 21);
  insert into public.order_packages values (119, 19, 'prepared', 1, 1, now()), (120, 20, 'prepared', 1, 1, now()), (121, 21, 'prepared', 1, 1, now());
  insert into public.order_package_parcels (package_id, attempt_number, parcel_count, parcel_index, barcode) values
    (119, 1, 1, 1, 'BX-PKG-1019-01'), (120, 1, 1, 1, 'BX-PKG-1020-01'), (121, 1, 1, 1, 'BX-PKG-1021-01');
  -- QR revocados: reimprimir rotaría el token.
  insert into public.local_delivery_shipments (order_id, access_token, token_revoked_at) values
    (19, 'tokenViejoBX1019AbCdEfGhIj', now()), (20, 'tokenViejoBX1020AbCdEfGhIj', now()), (21, 'tokenViejoBX1021AbCdEfGhIj', now());
`

const REASON = 'Compra de prueba del checkout hecha por el propietario.'
const CLASSIFY = 'select public.classify_test_order_admin($1, $2, $3, $4, true) as r'
const ENSURE = 'select public.ensure_local_delivery_shipment($1, $2, $3) as token'
const RECORD = "select public.record_local_delivery_labels_generated($1, $2, $3, 1, array['BX-PKG-' || (1000 + $1::bigint) || '-01']) as r"
// Mismo UPDATE que startPendingItemWarranties: sólo ítems sin garantía iniciada.
const WARRANTY = `update public.orden_items set warranty_started_at = now(), warranty_expires_at = now() + interval '6 months',
  warranty_status = 'active', warranty_months = 6 where orden_id = $1 and warranty_started_at is null and warranty_expires_at is null`
const NEW_TOKEN = (orderId) => `tokenNuevoBX${orderId}AbCdEfGhIjKlMn`
// Mismo INSERT que recordEffect (lib/orders/local-delivery-deps.ts) para la marca de Entregado del cron.
const MARKER = `insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values ($1, 'system', null, 'order_status_changed', 'en_camino', 'entregado', jsonb_build_object('previousEstado', 'en_camino',
    'newEstado', 'entregado', 'localDeliveryCost', 0, 'shippingProvider', 'beyonix', 'localDeliveryEffect', 'delivered_status',
    'localDeliveryEffectState', 'completed')) returning id`
// Lo que hace el cron antes de escribir: lee la clasificación (sin lock).
const CRON_READ = 'select test_order_at from public.ordenes where id = $1'

async function isWaiting(promise, ms = 400) {
  const marker = Symbol('pending')
  const result = await Promise.race([promise.then(() => 'done', () => 'failed'), new Promise((resolve) => setTimeout(() => resolve(marker), ms))])
  return result === marker
}

test('compras de prueba: clasificación contra etiquetas BEYONIX y garantía, con PostgreSQL real', { timeout: 300000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-test-dispatch-pg')
  const clients = []
  let databaseIndex = 0
  try {
    await server.initialise(); await server.start()

    const prepare = async () => {
      const name = `test_dispatch_${databaseIndex += 1}`
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
      await db.query(DISPATCH_SCHEMA)
      await db.query(MIGRATION)
      const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
      const state = async (orderId) => one(`select
        (select access_token from local_delivery_shipments where order_id = $1) token,
        (select token_revoked_at is not null from local_delivery_shipments where order_id = $1) revoked,
        (select count(*)::int from order_audit_events where order_id = $1 and action = 'local_delivery_labels_generated') labels,
        (select count(*)::int from orden_items where orden_id = $1 and warranty_started_at is not null) warranties,
        (select test_order_at is not null from ordenes where id = $1) classified`, [orderId])
      return { db, connect, state, one }
    }

    await t.test('clasificación en curso → la rotación del token espera y se rechaza; el QR viejo sigue revocado', async () => {
      const { connect, state } = await prepare()
      const [classification, label] = [await connect(), await connect()]
      await classification.query('begin')
      await classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
      const ensured = label.query(ENSURE, [19, OWNER, NEW_TOKEN(19)])
      assert.equal(await isWaiting(ensured), true, 'espera el lock del pedido')
      await classification.query('commit')
      await assert.rejects(ensured, /DISPATCH_TEST_ORDER/)
      assert.deepEqual(await state(19), { token: 'tokenViejoBX1019AbCdEfGhIj', revoked: true, labels: 0, warranties: 0, classified: true })
    })

    await t.test('clasificación en curso → el registro de reimpresión espera y se rechaza', async () => {
      const { connect, state } = await prepare()
      const [classification, label] = [await connect(), await connect()]
      await classification.query('begin')
      await classification.query(CLASSIFY, [20, OWNER, REASON, 'BX-1020'])
      const recorded = label.query(RECORD, [20, OWNER, 120])
      assert.equal(await isWaiting(recorded), true)
      await classification.query('commit')
      await assert.rejects(recorded, /DISPATCH_TEST_ORDER/)
      assert.equal((await state(20)).labels, 0)
    })

    await t.test('etiqueta primero → la clasificación espera; después ninguna reimpresión ni rotación más (sin deadlock)', async () => {
      const { connect, state } = await prepare()
      const [label, classification] = [await connect(), await connect()]
      await label.query('begin')
      assert.equal((await label.query(ENSURE, [19, OWNER, NEW_TOKEN(19)])).rows[0].token, NEW_TOKEN(19))
      await label.query(RECORD, [19, OWNER, 119])
      const classified = classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
      assert.equal(await isWaiting(classified), true, 'la clasificación espera el lock del pedido')
      await label.query('commit')
      assert.equal((await classified).rows[0].r.alreadyClassified, false)
      // La operación previa a la clasificación queda como historial; las siguientes se rechazan.
      assert.deepEqual(await state(19), { token: NEW_TOKEN(19), revoked: false, labels: 1, warranties: 0, classified: true })
      for (let retry = 0; retry < 3; retry += 1) {
        await assert.rejects(label.query(ENSURE, [19, OWNER, `tokenOtroBX1019Reintento${retry}Abc`]), /DISPATCH_TEST_ORDER/)
        await assert.rejects(label.query(RECORD, [19, OWNER, 119]), /DISPATCH_TEST_ORDER/)
      }
      assert.deepEqual(await state(19), { token: NEW_TOKEN(19), revoked: false, labels: 1, warranties: 0, classified: true }, 'reintentos idempotentes')
    })

    await t.test('clasificación en curso → el inicio de garantía (cron) espera y se rechaza; nada se activa', async () => {
      const { connect, state } = await prepare()
      const [classification, cron] = [await connect(), await connect()]
      await classification.query('begin')
      await classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
      const started = cron.query(WARRANTY, [19])
      assert.equal(await isWaiting(started), true, 'espera los locks del ítem / pedido')
      await classification.query('commit')
      await assert.rejects(started, /ORDER_TEST_WARRANTY_BLOCKED/)
      assert.equal((await state(19)).warranties, 0)
      await assert.rejects(cron.query(WARRANTY, [19]), /ORDER_TEST_WARRANTY_BLOCKED/, 'reintento del cron: igual')
    })

    await t.test('garantía primero → la clasificación espera y la garantía previa se conserva (historial, sin deadlock)', async () => {
      const { connect, state } = await prepare()
      const [cron, classification] = [await connect(), await connect()]
      await cron.query('begin')
      assert.equal((await cron.query(WARRANTY, [20])).rowCount, 1)
      const classified = classification.query(CLASSIFY, [20, OWNER, REASON, 'BX-1020'])
      assert.equal(await isWaiting(classified), true)
      await cron.query('commit')
      assert.equal((await classified).rows[0].r.alreadyClassified, false)
      assert.deepEqual(await state(20), { token: 'tokenViejoBX1020AbCdEfGhIj', revoked: true, labels: 0, warranties: 1, classified: true })
    })

    await t.test('pedidos reales: etiquetas, rotación de QR y garantía sin cambios, también mientras se clasifica otro pedido', async () => {
      const { connect, state } = await prepare()
      const [classification, label] = [await connect(), await connect()]
      await classification.query('begin')
      await classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
      // BX-1021 no espera a la clasificación de BX-1019.
      assert.equal((await label.query(ENSURE, [21, OWNER, NEW_TOKEN(21)])).rows[0].token, NEW_TOKEN(21))
      assert.equal((await label.query(RECORD, [21, OWNER, 121])).rows[0].r.reprint, false)
      assert.equal((await label.query(RECORD, [21, OWNER, 121])).rows[0].r.reprint, true, 'reimpresión registrada como tal')
      assert.equal((await label.query(WARRANTY, [21])).rowCount, 1)
      await classification.query('commit')
      assert.deepEqual(await state(21), { token: NEW_TOKEN(21), revoked: false, labels: 2, warranties: 1, classified: false })
      // Con token vigente, ensure devuelve el mismo (sin rotar).
      assert.equal((await label.query(ENSURE, [21, OWNER, 'tokenQueNoSeUsaAbCdEfGhIjKl'])).rows[0].token, NEW_TOKEN(21))
    })

    const markerState = (one) => async (orderId) => one(`select
      (select count(*)::int from order_audit_events where order_id = $1 and metadata ? 'localDeliveryEffect') markers,
      (select count(*)::int from order_audit_events where order_id = $1) events,
      (select stock from producto_variantes where id = 22) stock,
      (select estado from ordenes where id = $1) estado`, [orderId])

    await t.test('marca A: el cron leyó un pedido real, la clasificación se confirma y recién entonces escribe → rechazada, sin evento', async () => {
      const { connect, one } = await prepare()
      const state = markerState(one)
      const [cron, classification] = [await connect(), await connect()]
      assert.equal((await cron.query(CRON_READ, [19])).rows[0].test_order_at, null, 'el cron ve un pedido real')
      await classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
      const before = await state(19)
      await assert.rejects(cron.query(MARKER, [19]), /LOCAL_DELIVERY_EFFECT_TEST_ORDER/)
      for (let retry = 0; retry < 3; retry += 1) await assert.rejects(cron.query(MARKER, [19]), /LOCAL_DELIVERY_EFFECT_TEST_ORDER/)
      assert.deepEqual(await state(19), before, 'ni marca ni evento, stock y estado intactos (idempotente)')
    })

    await t.test('marca A bis: clasificación en curso → la marca espera, relee el pedido confirmado y se rechaza', async () => {
      const { connect, one } = await prepare()
      const state = markerState(one)
      const [classification, cron] = [await connect(), await connect()]
      await classification.query('begin')
      await classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
      const marked = cron.query(MARKER, [19])
      assert.equal(await isWaiting(marked), true, 'espera el lock del pedido (sin deadlock)')
      await classification.query('commit')
      await assert.rejects(marked, /LOCAL_DELIVERY_EFFECT_TEST_ORDER/)
      assert.equal((await state(19)).markers, 0)
    })

    await t.test('marca B: la marca va primero → la clasificación espera; la marca previa queda como historial', async () => {
      const { connect, one } = await prepare()
      const state = markerState(one)
      const [cron, classification] = [await connect(), await connect()]
      await cron.query('begin')
      await cron.query(MARKER, [20])
      const classified = classification.query(CLASSIFY, [20, OWNER, REASON, 'BX-1020'])
      assert.equal(await isWaiting(classified), true, 'la clasificación espera a la marca')
      await cron.query('commit')
      assert.equal((await classified).rows[0].r.alreadyClassified, false)
      assert.equal((await state(20)).markers, 1, 'la marca previa se conserva')
      await assert.rejects(cron.query(MARKER, [20]), /LOCAL_DELIVERY_EFFECT_TEST_ORDER/)
      assert.equal((await state(20)).markers, 1, 'ninguna marca más, sin duplicados')
    })

    await t.test('marca C: pedido real escribe sus marcas aunque otro se esté clasificando; eventos administrativos de una prueba siguen', async () => {
      const { connect, one } = await prepare()
      const state = markerState(one)
      const [classification, cron] = [await connect(), await connect()]
      await classification.query('begin')
      await classification.query(CLASSIFY, [19, OWNER, REASON, 'BX-1019'])
      // BX-1021 no espera a la clasificación de BX-1019 (aislamiento entre pedidos).
      const real = cron.query(MARKER, [21])
      assert.equal(await isWaiting(real, 200), false)
      await real
      await classification.query('commit')
      assert.equal((await state(21)).markers, 1)
      // Auditoría administrativa / fiscal sobre la prueba: sin metadata de efecto, no pasa por el guard.
      await cron.query("insert into order_audit_events (order_id, actor_type, actor_id, action, metadata) values (19, 'admin', $1, 'invoice_pdf_downloaded', '{}'::jsonb)", [OWNER])
      await cron.query("insert into order_audit_events (order_id, actor_type, action) values (19, 'system', 'payment_reconciled')")
      assert.equal((await one("select count(*)::int n from order_audit_events where order_id = 19 and action in ('invoice_pdf_downloaded', 'payment_reconciled')")).n, 2)
    })

    await t.test('permisos: SECURITY DEFINER con search_path fijo; sólo service_role ejecuta; el guard no es invocable', async () => {
      const { one } = await prepare()
      const rows = await one(`select json_agg(json_build_object('name', p.proname, 'secdef', p.prosecdef, 'config', p.proconfig,
          'anon', has_function_privilege('anon', p.oid, 'EXECUTE'), 'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
          'service', has_function_privilege('service_role', p.oid, 'EXECUTE')) order by p.proname) v
        from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('ensure_local_delivery_shipment', 'record_local_delivery_labels_generated', 'prevent_test_order_warranty_start', 'guard_test_order_local_delivery_effect')`)
      assert.equal(rows.v.length, 4)
      for (const fn of rows.v) {
        assert.equal(fn.secdef, true, fn.name)
        assert.deepEqual(fn.config, ['search_path=pg_catalog, public, pg_temp'], fn.name)
        assert.deepEqual([fn.anon, fn.authenticated], [false, false], fn.name)
        if (!['prevent_test_order_warranty_start', 'guard_test_order_local_delivery_effect'].includes(fn.name)) assert.equal(fn.service, true, fn.name)
      }
    })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
