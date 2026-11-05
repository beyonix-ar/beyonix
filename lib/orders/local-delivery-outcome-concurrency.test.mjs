import assert from 'node:assert/strict'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'
import { localDeliveryOutcomeSetupSql, OUTCOME_ACTOR as actor } from './fixtures/local-delivery-outcome-db.ts'

// Resultado de la entrega Envío BEYONIX con conexiones PostgreSQL REALES y
// simultáneas: siempre una única transición válida.

let requestNumber = 0
const key = () => `74000000-0000-4000-8000-${String(++requestNumber).padStart(12, '0')}`
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withIsolatedDatabase(run) {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-local-outcome-pg')
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
    for (const sql of localDeliveryOutcomeSetupSql()) await db.query(sql)
    await db.query("insert into profiles(id,rol) values ($1,'operador')", [actor])
    const a = await connect(); const b = await connect()
    await run({ db, a, b })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
}

function helpers(db) {
  let nextOrder = 1300
  /** Pedido local pagado, pickeado, con `parcels` bultos confirmados, QR emitido y En camino. */
  const inTransit = async ({ parcels = 1 } = {}) => {
    const orderId = ++nextOrder
    await db.query("insert into productos(id,sku,codigo_barra,nombre) values ($1,$2,$3,'Producto de prueba')", [orderId, `SKU-${orderId}`, `BAR-${orderId}`])
    await db.query('insert into catalog_sku_registry(normalized_sku,product_id,variant_id) values ($1,$2,null)', [`SKU-${orderId}`, orderId])
    await db.query('insert into product_cost_entries(product_id,received_quantity) values ($1,5)', [orderId])
    await db.query("insert into ordenes(id,shipping_provider,andreani_envio_id,andreani_creation_status) values ($1,'beyonix',null,null)", [orderId])
    await db.query('insert into orden_items(id,orden_id,producto_id,cantidad) values ($1,$1,$1,1)', [orderId])
    await db.query('select refresh_inventory_stock($1)', [orderId])
    await db.query('select begin_order_preparation($1,$2)', [orderId, actor])
    await db.query('select scan_order_preparation_code($1,$2,$3,$4)', [orderId, `BAR-${orderId}`, actor, key()])
    await db.query('select set_order_package_parcels($1,$2,$3,$4)', [orderId, parcels, actor, key()])
    const codes = []
    for (let index = 1; index <= parcels; index += 1) {
      const code = `BX-PKG-${1000 + orderId}-${String(index).padStart(2, '0')}`
      await db.query('select confirm_local_delivery_parcel($1,$2,$3)', [orderId, code, actor])
      codes.push(code)
    }
    const token = `concurrency${orderId}TokenAbCdEfGh`
    await db.query('select ensure_local_delivery_shipment($1,$2,$3)', [orderId, actor, token])
    await db.query("update ordenes set estado='en_camino' where id=$1", [orderId])
    return { orderId, token, codes }
  }
  const absent = (client, token, expected) =>
    client.query("select record_local_delivery_courier_outcome($1,'absent',$2) result", [token, expected]).then((r) => r.rows[0].result)
  const courierDelivered = (client, token) => client.query('select id from mark_local_delivery_delivered_by_courier($1)', [token]).then((r) => r.rows)
  const state = async (orderId) => (await db.query(
    'select o.estado, s.outcome_status, s.failed_attempts from ordenes o join local_delivery_shipments s on s.order_id=o.id where o.id=$1', [orderId])).rows[0]
  const audits = async (orderId, action) => (await db.query('select count(*)::int count from order_audit_events where order_id=$1 and action=$2', [orderId, action])).rows[0].count
  const toReturned = async (token, codes, orderId) => {
    await absent(db, token, 0)
    await absent(db, token, 1)
    for (const code of codes) await db.query('select receive_local_delivery_return_parcel($1,$2,3)', [code, actor])
    await db.query("update local_delivery_return_reservations set starts_at=now()-interval '5 days', expires_at=now()-interval '1 minute' where order_id=$1", [orderId])
  }
  return { inTransit, absent, courierDelivered, state, audits, toReturned }
}

test('resultado de entrega Envío BEYONIX: transiciones concurrentes reales', { timeout: 300000 }, async (t) => {
  await withIsolatedDatabase(async ({ db, a, b }) => {
    const { inTransit, absent, courierDelivered, state, audits, toReturned } = helpers(db)

    await t.test('dos escaneos "Cliente ausente" simultáneos del mismo intento => un solo intento registrado', async () => {
      const { orderId, token } = await inTransit()
      const [first, second] = await Promise.all([settle(absent(a, token, 0)), settle(absent(b, token, 0))])
      assert.ok(first.ok && second.ok, first.error?.message ?? second.error?.message)
      assert.deepEqual([first.value.result, second.value.result].sort(), ['first_attempt_failed', 'unchanged'])
      assert.deepEqual(await state(orderId), { estado: 'en_camino', outcome_status: 'first_attempt_failed', failed_attempts: 1 })
      assert.equal(await audits(orderId, 'local_delivery_attempt_failed'), 1)
    })

    await t.test('dos "Cliente ausente" simultáneos del 2.º intento => uno vuelve a BEYONIX y el otro es un tercer intento rechazado', async () => {
      const { orderId, token } = await inTransit()
      await absent(db, token, 0)
      const [first, second] = await Promise.all([settle(absent(a, token, 1)), settle(absent(b, token, 1))])
      assert.ok(first.ok && second.ok, first.error?.message ?? second.error?.message)
      assert.deepEqual([first.value.result, second.value.result].sort(), ['max_attempts', 'returning'])
      assert.deepEqual(await state(orderId), { estado: 'en_camino', outcome_status: 'returning', failed_attempts: 2 })
      assert.equal(await audits(orderId, 'local_delivery_attempt_failed'), 2)
    })

    await t.test('cancelación concurrente con la recepción del último bulto => retención resuelta una sola vez, sin re-escaneo', async () => {
      const { orderId, token, codes } = await inTransit({ parcels: 2 })
      await absent(db, token, 0)
      await absent(db, token, 1)
      await db.query('select receive_local_delivery_return_parcel($1,$2,3)', [codes[0], actor])
      await a.query('begin')
      await a.query('select receive_local_delivery_return_parcel($1,$2,3)', [codes[1], actor])
      const cancel = settle(b.query("update ordenes set estado='cancelado', cancelled_at=now(), payment_status='cancelado' where id=$1", [orderId]))
      await pause(300)
      await a.query('commit')
      const outcome = await cancel
      assert.ok(outcome.ok, outcome.error?.message)
      const holds = (await db.query('select resolved_at is not null resolved, resolution_code from order_cancellation_holds where order_id=$1', [orderId])).rows
      assert.deepEqual(holds, [{ resolved: true, resolution_code: 'LOCAL-RETURN-RECEIVED' }])
      assert.equal(await audits(orderId, 'dispatch_cancellation_physically_resolved'), 1)
      assert.equal((await db.query('select stock::int from productos where id=$1', [orderId])).rows[0].stock, 5, 'stock completo, nunca de más')
    })

    await t.test('cadete marca Entregado dos veces a la vez => una sola transición', async () => {
      const { orderId, token } = await inTransit()
      const [first, second] = await Promise.all([settle(courierDelivered(a, token)), settle(courierDelivered(b, token))])
      assert.ok(first.ok && second.ok)
      assert.equal(first.value.length + second.value.length, 1)
      assert.deepEqual(await state(orderId), { estado: 'entregado', outcome_status: 'delivered', failed_attempts: 0 })
    })

    await t.test('tras el 1.er intento: segundo ausente y Entregado concurrentes => un único resultado final', async () => {
      for (const absentFirst of [true, false]) {
        const { orderId, token } = await inTransit()
        await absent(db, token, 0)
        // El que toma primero el lock del pedido gana; el otro ve el estado ya cambiado.
        const winner = absentFirst ? a : b
        await winner.query('begin')
        if (absentFirst) await absent(a, token, 1)
        else await courierDelivered(b, token)
        const loser = absentFirst ? settle(courierDelivered(b, token)) : settle(absent(a, token, 1))
        await pause(300)
        await winner.query('commit')
        const outcome = await loser
        assert.ok(outcome.ok, outcome.error?.message)
        const final = await state(orderId)
        if (absentFirst) {
          assert.deepEqual(outcome.value, [], 'Entregado no pasa sobre un pedido que vuelve')
          assert.deepEqual(final, { estado: 'en_camino', outcome_status: 'returning', failed_attempts: 2 })
        } else {
          assert.equal(outcome.value.result, 'already_delivered')
          assert.deepEqual(final, { estado: 'entregado', outcome_status: 'delivered', failed_attempts: 1 })
        }
      }
    })

    await t.test('Admin marca Entregado mientras el cadete marca el 2.º ausente => el UPDATE de Admin espera y la guarda lo frena', async () => {
      const { orderId, token } = await inTransit()
      await absent(db, token, 0)
      await a.query('begin')
      await absent(a, token, 1)
      const adminUpdate = settle(b.query("update ordenes set estado='entregado', delivered_at=now() where id=$1 and estado='en_camino' returning id", [orderId]))
      await pause(300)
      await a.query('commit')
      const outcome = await adminUpdate
      assert.equal(outcome.ok, false)
      assert.match(outcome.error.message, /LOCAL_DELIVERY_RETURN_IN_PROGRESS/)
      assert.deepEqual(await state(orderId), { estado: 'en_camino', outcome_status: 'returning', failed_attempts: 2 })
    })

    await t.test('Admin entrega primero y el cadete marca ausente => el ausente ve Entregado y no escribe', async () => {
      const { orderId, token } = await inTransit()
      await a.query('begin')
      await a.query("update ordenes set estado='entregado', delivered_at=now() where id=$1", [orderId])
      const courier = settle(absent(b, token, 0))
      await pause(300)
      await a.query('commit')
      const outcome = await courier
      assert.ok(outcome.ok, outcome.error?.message)
      assert.equal(outcome.value.result, 'already_delivered')
      assert.equal(await audits(orderId, 'local_delivery_attempt_failed'), 0)
    })

    await t.test('recepción del mismo BX-PKG en dos lectores a la vez => un recibo, una recepción y una reserva', async () => {
      const { orderId, token, codes } = await inTransit({ parcels: 1 })
      await absent(db, token, 0)
      await absent(db, token, 1)
      const receive = (client) => client.query('select receive_local_delivery_return_parcel($1,$2,3) result', [codes[0], actor]).then((r) => r.rows[0].result)
      const [first, second] = await Promise.all([settle(receive(a)), settle(receive(b))])
      assert.ok(first.ok && second.ok, first.error?.message ?? second.error?.message)
      assert.deepEqual([first.value.duplicate, second.value.duplicate].sort(), [false, true])
      assert.equal([first.value.completedNow, second.value.completedNow].filter(Boolean).length, 1)
      assert.equal((await db.query('select count(*)::int count from local_delivery_return_receipts r join local_delivery_shipments s on s.id=r.shipment_id where s.order_id=$1', [orderId])).rows[0].count, 1)
      assert.equal((await db.query('select count(*)::int count from local_delivery_return_reservations where order_id=$1', [orderId])).rows[0].count, 1)
      assert.equal(await audits(orderId, 'local_delivery_return_received'), 1)
    })

    await t.test('vencimiento mientras Admin coordina el reenvío => una sola resolución (consumida o vencida)', async () => {
      for (const consumeFirst of [true, false]) {
        const { orderId, token, codes } = await inTransit()
        await toReturned(token, codes, orderId)
        // Vence en el futuro inmediato para que el consumo sea válido si gana.
        await db.query("update local_delivery_return_reservations set expires_at=now()+interval '2 seconds' where order_id=$1", [orderId])
        const stockBefore = (await db.query('select stock::int from productos where id=$1', [orderId])).rows[0].stock
        if (consumeFirst) {
          await a.query('begin')
          await a.query('select consume_local_delivery_return_reservation($1,$2)', [orderId, actor])
          await pause(2200)
          const job = settle(b.query('select expire_local_delivery_return_reservations(100) result'))
          await pause(300)
          await a.query('commit')
          const outcome = await job
          assert.ok(outcome.ok, outcome.error?.message)
        } else {
          await pause(2200)
          await a.query('begin')
          await a.query('select expire_local_delivery_return_reservations(100)')
          const consume = settle(b.query('select consume_local_delivery_return_reservation($1,$2)', [orderId, actor]))
          await pause(300)
          await a.query('commit')
          const outcome = await consume
          assert.equal(outcome.ok, false)
          assert.match(outcome.error.message, /LOCAL_DELIVERY_RESERVATION_NOT_ACTIVE/)
        }
        const status = (await db.query('select status from local_delivery_return_reservations where order_id=$1', [orderId])).rows[0].status
        assert.equal(status, consumeFirst ? 'consumed' : 'expired')
        const stockAfter = (await db.query('select stock::int from productos where id=$1', [orderId])).rows[0].stock
        assert.equal(stockAfter, consumeFirst ? stockBefore : stockBefore + 1, 'el stock se libera sólo si venció')
      }
    })

    await t.test('dos ejecuciones simultáneas del job => cada reserva vence una sola vez', async () => {
      const orders = []
      for (let index = 0; index < 3; index += 1) {
        const created = await inTransit()
        await toReturned(created.token, created.codes, created.orderId)
        orders.push(created.orderId)
      }
      const before = await Promise.all(orders.map(async (id) => (await db.query('select stock::int from productos where id=$1', [id])).rows[0].stock))
      const [first, second] = await Promise.all([
        settle(a.query('select expire_local_delivery_return_reservations(100) result')),
        settle(b.query('select expire_local_delivery_return_reservations(100) result')),
      ])
      assert.ok(first.ok && second.ok, first.error?.message ?? second.error?.message)
      // Pueden quedar reservas de otros subtests ya resueltas: sólo cuentan las de estos pedidos.
      for (const [index, id] of orders.entries()) {
        assert.equal(await audits(id, 'local_delivery_return_reservation_expired'), 1, `pedido ${id}`)
        assert.equal((await db.query('select stock::int from productos where id=$1', [id])).rows[0].stock, before[index] + 1)
      }
    })
  })
})
