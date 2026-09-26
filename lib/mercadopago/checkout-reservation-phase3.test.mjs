import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import test from 'node:test'
import EmbeddedPostgres from 'embedded-postgres'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const old = read('../../supabase/migrations/20260903150000_checkout_stock_reservation_window.sql')
const available = old.match(/create or replace function public\.available_stock_for_session\([\s\S]*?\n\$\$;/)?.[0]
const decrement = read('../inventory/fixtures/inventory-hardening-functions.sql')
  .match(/create or replace function public\.decrement_checkout_inventory\([\s\S]*?\$function\$;/)?.[0]
const consumes = read('../../supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql')
  .match(/create or replace function public\.inventory_order_consumes_stock\([\s\S]*?\$function\$;/)?.[0]
const release = read('../../supabase/migrations/20260801095000_stock_reservations.sql')
  .match(/create or replace function public\.release_order_stock_reservation\([\s\S]*?\n\$\$;/)?.[0]
assert.ok(available && decrement && consumes && release)

test('la ruta crea la preference sólo después del commit atómico de la reserva', () => {
  const route = read('../../app/api/mercadopago/create-preference/route.ts')
  assert.match(route, /reservationCommitment: "mercadopago"/)
  assert.ok(route.indexOf('const reservationExpiresAt = await insertCheckoutOrderItemsAndValidateInventory') <
    route.indexOf('preferenceResult = await createAndPersistMercadoPagoPreference'))
  assert.match(route, /expiration_date_to: expiresAt\.toISOString\(\)/)
  assert.match(route, /date_of_expiration: expiresAt\.toISOString\(\)/)
  assert.match(route, /getMercadoPagoReservationPreferenceExpiration\(reservationExpiresAt, createdAt\)/)
})

test('Mercado Pago: compromiso y aprobación sobre PostgreSQL real', { timeout: 180000 }, async (t) => {
  const socket = createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'beyonix-mp-reservation-')),
    port, user: 'postgres', password: 'isolated-test', persistent: true,
    postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} })
  const clients = []
  const connect = async () => {
    const client = server.getPgClient('postgres', '127.0.0.1')
    await client.connect(); clients.push(client)
    await client.query("set request.jwt.claim.role = 'service_role'")
    await client.query("set statement_timeout = '10s'")
    return client
  }
  try {
    await server.initialise(); await server.start()
    const db = await connect()
    await db.query(read('../inventory/fixtures/inventory-hardening-schema.sql'))
    await db.query("alter table ordenes add column payment_method_id text, add column payment_confirmed_at timestamptz")
    await db.query("create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$")
    await db.query(available); await db.query(decrement)
    await db.query('create function public.complete_cart_stock_reservation(text,bigint) returns void language sql as $$ select $$')
    await db.query("create function public.validate_checkout_inventory_reservation(jsonb,text,bigint) returns jsonb language sql as $$ select '{}'::jsonb $$")
    await db.query(read('../../supabase/migrations/20260925120000_checkout_step_stock_reservations.sql'))
    await db.query(read('../../supabase/migrations/20260925130000_mercadopago_checkout_reservation_commit.sql'))
    await db.query(consumes); await db.query(release)
    await db.query('create trigger release_order_stock_reservation after update of estado, payment_status or delete on ordenes for each row execute function public.release_order_stock_reservation()')
    const a = await connect(); const b = await connect()
    let sequence = 0
    const setup = async (quantities, owner = null) => {
      const key = `mp-phase3-${++sequence}-aaaaaaaa`
      const items = []
      for (const stock of quantities) {
        const id = (await db.query('insert into productos(stock) values($1) returning id', [stock])).rows[0].id
        items.push({ product_id: id, quantity: 1, variant_id: null, conditioned_stock_id: null })
      }
      const order = (await db.query("insert into ordenes(usuario_id,payment_method_id,mercadopago_reservation_session_id) values($1,'mercadopago',$2) returning id", [owner, key])).rows[0].id
      for (const item of items) await db.query(
        'insert into orden_items(orden_id,producto_id,cantidad) values($1,$2,$3)',
        [order, item.product_id, item.quantity])
      return { key, items, order }
    }
    const reserve = (client, x) => client.query('select reserve_cart_stock($1,$2) as result',
      [x.key, JSON.stringify(x.items.map((item) => ({ productId: item.product_id,
        variantId: item.variant_id, conditionedStockId: item.conditioned_stock_id,
        quantity: item.quantity })))])
    const commit = (client, x, items = x.items, key = x.key, order = x.order) =>
      client.query('select commit_mercadopago_checkout_reservation($1,$2,$3) as expiry',
        [JSON.stringify(items), key, order])

    await t.test('sin reserva, vencida, ajena e ítem inválido: no hay compromiso parcial', async () => {
      const x = await setup([2, 2])
      await assert.rejects(commit(a, x), /RESERVATION_EXPIRED/)
      await reserve(a, x)
      await assert.rejects(commit(a, x, x.items.slice(0, 1)), /RESERVATION_INVALID/)
      assert.equal((await db.query('select count(*)::int n from stock_reservations where order_id=$1', [x.order])).rows[0].n, 0)
      const y = await setup([1])
      await assert.rejects(commit(a, x, x.items, x.key, y.order), /RESERVATION_INVALID|INVALID_SESSION|RESERVATION_LOCKED_TO_ORDER/)
      await db.query("update checkout_reservation_sessions set reservation_started_at=now()-interval '21 minutes', expires_at=now()-interval '1 second' where session_id=$1", [x.key])
      await assert.rejects(commit(a, x), /RESERVATION_EXPIRED/)
    })
    await t.test('multítem: expiry original, idempotencia y reserva de otra compra', async () => {
      const x = await setup([1, 1]); await reserve(a, x)
      const original = (await db.query('select expires_at from checkout_reservation_sessions where session_id=$1', [x.key])).rows[0].expires_at
      const outcomes = await Promise.allSettled([commit(a, x), commit(b, x)])
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 2)
      assert.equal(new Date(outcomes[0].value.rows[0].expiry).getTime(), new Date(original).getTime())
      assert.equal((await db.query('select count(*)::int n from stock_reservations where order_id=$1', [x.order])).rows[0].n, 2)
      await assert.rejects(reserve(a, x), /RESERVATION_LOCKED_TO_ORDER/)
      const y = await setup([1]); y.items[0].product_id = x.items[0].product_id
      await assert.rejects(reserve(b, y), /OUT_OF_STOCK/)
    })
    await t.test('la variante de la orden debe coincidir con la reserva', async () => {
      const x = await setup([2])
      const variant = (await db.query('insert into producto_variantes(producto_id,stock) values($1,2) returning id', [x.items[0].product_id])).rows[0].id
      x.items[0].variant_id = variant
      await db.query('update orden_items set variante_id=$1 where orden_id=$2', [variant, x.order])
      await reserve(a, x)
      await assert.rejects(commit(a, x, [{ ...x.items[0], variant_id: null }]), /RESERVATION_INVALID/)
      await commit(a, x)
    })
    await t.test('aprobación en plazo cierra reserva; repetida no consume de nuevo', async () => {
      const x = await setup([1]); await reserve(a, x); await commit(a, x)
      await db.query("update ordenes set estado='pagado', payment_status='approved', payment_confirmed_at=now() where id=$1", [x.order])
      await db.query("update ordenes set payment_status='approved' where id=$1", [x.order])
      assert.equal((await db.query('select count(*)::int n from stock_reservations where order_id=$1', [x.order])).rows[0].n, 0)
    })
    await t.test('approved tardío sin pending: conflicto y sin consumo', async () => {
      const x = await setup([1]); await reserve(a, x); await commit(a, x)
      await assert.rejects(db.query("update ordenes set estado='pagado', payment_status='approved', payment_confirmed_at=now()+interval '30 minutes' where id=$1", [x.order]), /RESERVATION_APPROVAL_EXPIRED/)
      assert.equal((await db.query('select estado from ordenes where id=$1', [x.order])).rows[0].estado, 'pendiente')
    })
    await t.test('approved fechado en término pero entregado tarde no pisa otra reserva', async () => {
      const x = await setup([1]); await reserve(a, x); await commit(a, x)
      await db.query("update checkout_reservation_sessions set reservation_started_at=now()-interval '21 minutes', expires_at=now()-interval '1 second' where session_id=$1", [x.key])
      await db.query("update stock_reservations set expires_at=now()-interval '1 second' where order_id=$1", [x.order])
      const expired = (await db.query('select expires_at from checkout_reservation_sessions where session_id=$1', [x.key])).rows[0].expires_at
      const y = await setup([1]); y.items[0].product_id = x.items[0].product_id
      await reserve(b, y)
      await assert.rejects(db.query("update ordenes set estado='pagado', payment_status='approved', payment_confirmed_at=$2 where id=$1", [x.order, new Date(expired.getTime() - 1000)]), /CHECKOUT_STOCK_INSUFFICIENT/)
      assert.equal((await db.query('select estado from ordenes where id=$1', [x.order])).rows[0].estado, 'pendiente')
    })
    await t.test('a menos de un minuto no se compromete ni se crea una ventana nueva', async () => {
      const x = await setup([1]); await reserve(a, x)
      await db.query("update checkout_reservation_sessions set reservation_started_at=now()-interval '19 minutes 30 seconds', expires_at=now()+interval '30 seconds' where session_id=$1", [x.key])
      await assert.rejects(commit(a, x), /RESERVATION_EXPIRED/)
      assert.equal((await db.query('select count(*)::int n from stock_reservations where order_id=$1', [x.order])).rows[0].n, 0)
    })
    await t.test('pending real retiene stock; rejected libera sin renovar el reloj', async () => {
      const x = await setup([1]); await reserve(a, x); await commit(a, x)
      await db.query("update ordenes set payment_status='pending' where id=$1", [x.order])
      assert.equal((await db.query('select expires_at::text from stock_reservations where order_id=$1', [x.order])).rows[0].expires_at, 'infinity')
      await db.query("update ordenes set payment_status='rejected' where id=$1", [x.order])
      const dates = (await db.query('select r.expires_at, s.expires_at original from stock_reservations r join checkout_reservation_sessions s using(session_id) where r.order_id=$1', [x.order])).rows[0]
      assert.equal(dates.expires_at.getTime(), dates.original.getTime())
    })
    await t.test('pending real permite aprobación posterior sin sobreventa', async () => {
      const x = await setup([1]); await reserve(a, x); await commit(a, x)
      await db.query("update ordenes set payment_status='pending' where id=$1", [x.order])
      const y = await setup([1]); y.items[0].product_id = x.items[0].product_id
      await assert.rejects(reserve(b, y), /OUT_OF_STOCK/)
      await db.query("update ordenes set estado='pagado', payment_status='approved', payment_confirmed_at=now()+interval '30 minutes' where id=$1", [x.order])
      assert.equal((await db.query('select count(*)::int n from stock_reservations where order_id=$1', [x.order])).rows[0].n, 0)
    })
    await t.test('cancelled no consume inventario ni renueva la reserva', async () => {
      const x = await setup([1]); await reserve(a, x); await commit(a, x)
      await db.query("update ordenes set payment_status='cancelled' where id=$1", [x.order])
      const row = (await db.query('select o.estado, r.expires_at, s.expires_at original from ordenes o join stock_reservations r on r.order_id=o.id join checkout_reservation_sessions s using(session_id) where o.id=$1', [x.order])).rows[0]
      assert.equal(row.estado, 'pendiente')
      assert.equal(row.expires_at.getTime(), row.original.getTime())
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    if (server.process && server.process.exitCode === null && server.process.signalCode === null) await server.stop()
  }
})
