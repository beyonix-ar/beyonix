import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Devolución por retiro de cadete (Envío BEYONIX) con PostgreSQL REAL y dos
// backends independientes: recepciones, pérdidas en traslado, inspección,
// cancelación e idempotencia en carrera. La autoridad es el lock del reclamo
// (lock_order_claim_for_local_pickup) más el advisory lock de la clave.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const migration = (name) => read(`../../supabase/migrations/${name}.sql`)

const CHAIN = [
  '20260816120000_atomic_order_claim_cancellation',
  '20260905150000_claims_atomic_operations',
  '20260906090000_claim_case_type_transitions',
  '20260906100000_claims_final_security',
  '20260906110000_claim_credit_note_snapshot',
  '20260920100000_inventory_return_movements_reproducibility',
  '20260920110000_unify_return_reception_rpc',
  '20260920140000_order_replacements',
  '20260922120000_replacement_operation_guard',
  '20260922130000_replacement_admin_audit',
  '20260924150000_claim_product_change_requires_replacement',
  '20260924140000_order_claim_customer_reads',
  '20260924160000_claim_resolution_summary_notifications',
  '20260928100000_claim_andreani_shipments',
  '20260930100000_claim_logistics_branch_only',
  '20261001100000_claim_logistics_hardening',
  '20261001120000_reopen_rejected_order_claim',
  '20261001130000_cancel_order_claim',
  '20261001170000_claim_return_dropoff_copy',
  '20261019120000_claim_policy_consolidation',
  '20261020100000_claim_item_resolutions',
  '20261020110000_claim_item_return_obligation',
  '20261106110000_dispatch_records_carrier_filter',
  '20261106120000_claim_local_pickups',
]

const customer = '50000000-0000-4000-8000-000000000001'
const admin = '50000000-0000-4000-8000-000000000003'
const admin2 = '50000000-0000-4000-8000-000000000005'
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))

test('retiro por cadete: recepción, pérdida, inspección, cancelación e idempotencia concurrentes', { timeout: 300000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-claim-local-pickup-pg')
  const clients = []
  const connect = async (database = 'beyonix') => {
    const client = server.getPgClient(database, '127.0.0.1')
    await client.connect()
    clients.push(client)
    if (database !== 'beyonix') return client
    await client.query("set statement_timeout = '15s'")
    await client.query("set lock_timeout = '10s'")
    await client.query("set request.jwt.claim.role = 'service_role'")
    return client
  }

  try {
    await server.initialise(); await server.start()
    // UTF8 explícito: en Windows el cluster embebido nace en WIN1252.
    await (await connect('postgres')).query("create database beyonix encoding 'UTF8' template template0")
    const db = await connect()
    await db.query(read('./fixtures/claim-logistics-schema.sql'))
    await db.query('alter table ordenes add column shipping_provider text, add column envio_proveedor text')
    for (const name of CHAIN) await db.query(migration(name))
    for (const [id, role] of [[customer, 'cliente'], [admin, 'admin'], [admin2, 'admin']]) {
      await db.query('insert into auth.users values($1,$2,now())', [id, `${id}@example.test`])
      await db.query('insert into profiles(id,email,rol) values($1,$2,$3)', [id, `${id}@example.test`, role])
    }
    await db.query('insert into productos(id) values(1); insert into producto_variantes(id,producto_id) values(1,1)')
    await db.query("select adjust_variant_stock_idempotent(1,20,'seed de test',$1,'seed-local-pickup-1')", [admin])
    const a = await connect()
    const b = await connect()

    let orderId = 0
    /** Pedido Envío BEYONIX entregado + reclamo aceptado con `quantity` unidades + retiro retirado por el cadete. */
    async function collectedClaim({ quantity = 2, resolution = 'reintegro_total', status = 'reintegro_pendiente', collect = true } = {}) {
      orderId += 1
      await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type,shipping_provider) values($1,$2,'entregado',now()-interval '1 day','payment_confirmed',90000,'domicilio','beyonix')", [orderId, customer])
      await db.query('insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values($1,$1,1,1,$2,30000)', [orderId, quantity])
      const op = randomUUID()
      await db.query("select begin_order_claim_operation($1,$2,$3,$4,'{}','order-claim-evidence')", [op, customer, orderId, randomUUID().replaceAll('-', '').repeat(2)])
      const claimId = Number((await db.query("select commit_customer_order_claim($1,$2,$3,'[]') as id",
        [op, customer, JSON.stringify({ problemType: 'falla', message: 'El producto dejó de funcionar.', items: [{ order_item_id: orderId, quantity }] })])).rows[0].id)
      const version = (await db.query('select updated_at::text v from order_claims where id=$1', [claimId])).rows[0].v
      await db.query('select mutate_admin_order_claim($1,$2,$3,$4)', [claimId, admin, version, JSON.stringify({ status, resolution })])
      await db.query("select * from request_order_claim_local_pickup($1,$2,'Coordinar')", [claimId, admin])
      if (collect) await db.query("select * from mark_order_claim_local_pickup_collected($1,$2,'Retiró el cadete')", [claimId, admin])
      return claimId
    }
    const receive = (client, claimId, quantity, { key = randomUUID(), note = '', actor = admin } = {}) =>
      client.query('select status from confirm_order_claim_local_pickup_reception($1,$2,$3,$4,$5)',
        [claimId, actor, JSON.stringify([{ order_item_id: itemOf(claimId), quantity }]), note, key])
    const loss = (client, claimId, quantity, { key = randomUUID(), note = 'El cadete perdió el paquete en el traslado', actor = admin } = {}) =>
      client.query('select status from confirm_order_claim_local_pickup_loss($1,$2,$3,$4,$5)',
        [claimId, actor, JSON.stringify([{ order_item_id: itemOf(claimId), quantity }]), note, key])
    const inspect = (client, claimId, restock) =>
      client.query("select process_claim_return_inventory($1,$2,$2,$3,0,'Revisado en depósito',$4,$5)", [claimId, itemOf(claimId), restock, admin, randomUUID()])
    const itemIds = new Map()
    const itemOf = (claimId) => itemIds.get(claimId)
    const remember = (claimId) => { itemIds.set(claimId, orderId); return claimId }
    const state = async (claimId) => (await db.query(
      `select (select status from order_claim_local_pickups where claim_id=$1 and status <> 'cancelado' order by id desc limit 1) pickup,
              (select string_agg(location || ':' || n, ',' order by location) from (
                select location, count(*) n from order_claim_units where claim_id=$1 and role='original' group by location) x) units,
              (select count(*)::int from order_claim_local_pickup_receptions where claim_id=$1) receptions,
              (select count(*)::int from order_claim_local_pickup_losses where claim_id=$1) losses`, [claimId])).rows[0]
    const stock = async () => Number((await db.query('select stock from producto_variantes where id=1')).rows[0].stock)
    /** B quedó esperando un lock (no pasó por delante de A). */
    const waitUntilBlocked = async (client) => {
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const row = (await db.query('select wait_event_type from pg_stat_activity where pid=$1', [client.processID])).rows[0]
        if (row?.wait_event_type === 'Lock') return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.fail('la segunda transacción nunca esperó el lock')
    }
    /** A ejecuta dentro de una transacción abierta; B arranca, queda bloqueada; A confirma; B termina. */
    const race = async (first, second) => {
      await a.query('begin')
      const firstResult = await settle(first(a))
      if (!firstResult.ok) { await a.query('rollback'); throw firstResult.error }
      const pending = settle(second(b))
      try {
        await waitUntilBlocked(b)
      } catch (error) {
        await a.query('rollback')
        await pending
        throw error
      }
      await a.query('commit')
      return [firstResult, await pending]
    }
    /** Ambas a la vez, sin orden impuesto (puede ganar cualquiera). */
    const simultaneous = (first, second) => Promise.all([settle(first(a)), settle(second(b))])

    await t.test('1. dos recepciones simultáneas de la última unidad: una sola se registra', async () => {
      const claimId = remember(await collectedClaim({ quantity: 2 }))
      await receive(db, claimId, 1)
      const [first, second] = await race((c) => receive(c, claimId, 1), (c) => receive(c, claimId, 1))
      assert.equal(first.ok, true)
      assert.equal(second.ok, false)
      assert.match(String(second.error.message), /CLAIM_LOCAL_PICKUP_NOT_COLLECTED|CLAIM_UNITS_NOT_AVAILABLE/)
      assert.deepEqual(await state(claimId), { pickup: 'recibido', units: 'recibida_beyonix:2', receptions: 2, losses: 0 })
      // Sin orden impuesto también: nunca más de lo pendiente.
      const other = remember(await collectedClaim({ quantity: 1 }))
      const results = await simultaneous((c) => receive(c, other, 1), (c) => receive(c, other, 1))
      assert.equal(results.filter((result) => result.ok).length, 1)
      assert.deepEqual(await state(other), { pickup: 'recibido', units: 'recibida_beyonix:1', receptions: 1, losses: 0 })
    })

    await t.test('2. recepción y pérdida simultáneas de la misma unidad: gana una, nunca ambas', async () => {
      const receivedFirst = remember(await collectedClaim({ quantity: 1 }))
      const [r1, r2] = await race((c) => receive(c, receivedFirst, 1), (c) => loss(c, receivedFirst, 1))
      assert.equal(r1.ok, true)
      assert.match(String(r2.error?.message), /CLAIM_LOCAL_PICKUP_NOT_COLLECTED|CLAIM_UNITS_NOT_AVAILABLE/)
      assert.deepEqual(await state(receivedFirst), { pickup: 'recibido', units: 'recibida_beyonix:1', receptions: 1, losses: 0 })

      const lostFirst = remember(await collectedClaim({ quantity: 1 }))
      const [l1, l2] = await race((c) => loss(c, lostFirst, 1), (c) => receive(c, lostFirst, 1))
      assert.equal(l1.ok, true)
      assert.match(String(l2.error?.message), /CLAIM_LOCAL_PICKUP_NOT_COLLECTED|CLAIM_UNITS_NOT_AVAILABLE/)
      assert.deepEqual(await state(lostFirst), { pickup: 'resuelto_con_perdida', units: 'perdida_traslado:1', receptions: 0, losses: 1 })
    })

    await t.test('3. dos declaraciones de pérdida simultáneas (claves distintas): una sola', async () => {
      const claimId = remember(await collectedClaim({ quantity: 2 }))
      const [first, second] = await race((c) => loss(c, claimId, 2), (c) => loss(c, claimId, 1, { actor: admin2 }))
      assert.equal(first.ok, true)
      assert.match(String(second.error?.message), /CLAIM_LOCAL_PICKUP_NOT_COLLECTED|CLAIM_UNITS_NOT_AVAILABLE/)
      assert.deepEqual(await state(claimId), { pickup: 'resuelto_con_perdida', units: 'perdida_traslado:2', receptions: 0, losses: 1 })
      const audits = (await db.query("select count(*)::int n from order_audit_events where action='claim_local_pickup_loss_confirmed' and metadata->>'pickupId' = (select id::text from order_claim_local_pickups where claim_id=$1)", [claimId])).rows[0].n
      assert.equal(audits, 1)
    })

    await t.test('4. recepción e inspección concurrentes: nunca se inspecciona (ni vuelve a stock) lo que no se recibió', async () => {
      const claimId = remember(await collectedClaim({ quantity: 2 }))
      await receive(db, claimId, 1)
      const before = await stock()
      // La recepción toma los locks primero; la inspección de 2 espera y ve lo confirmado.
      const [received, inspected] = await race((c) => receive(c, claimId, 1), (c) => inspect(c, claimId, 2))
      assert.equal(received.ok, true)
      assert.equal(inspected.ok, true, String(inspected.error?.message))
      assert.equal(await stock(), before + 2)
      assert.deepEqual(await state(claimId), { pickup: 'recibido', units: 'reincorporada_stock:2', receptions: 2, losses: 0 })

      // La inspección empieza primero (sólo 1 recibida): pedir 2 falla aunque la recepción llegue en paralelo.
      const other = remember(await collectedClaim({ quantity: 2 }))
      await receive(db, other, 1)
      const stockBefore = await stock()
      const results = await simultaneous((c) => inspect(c, other, 2), (c) => receive(c, other, 1))
      const final = await state(other)
      const restocked = Number(/reincorporada_stock:(\d)/.exec(final.units ?? '')?.[1] ?? 0)
      assert.equal(await stock(), stockBefore + restocked, 'stock = unidades efectivamente inspeccionadas')
      assert.ok(results[1].ok, 'la recepción siempre se registra')
      if (!results[0].ok) assert.match(String(results[0].error.message), /CLAIM_LOCAL_PICKUP_NOT_RECEIVED/)
      assert.ok(restocked === 0 || restocked === 2)
    })

    await t.test('5. cancelación y registro de retiro simultáneos: un solo resultado coherente', async () => {
      const cancelFirst = remember(await collectedClaim({ quantity: 1, collect: false }))
      const cancel = (c, claimId) => c.query("select status from cancel_order_claim_local_pickup($1,$2,'El cliente desistió del retiro')", [claimId, admin])
      const collect = (c, claimId) => c.query("select status from mark_order_claim_local_pickup_collected($1,$2,'Retiró el cadete')", [claimId, admin])
      const [c1, c2] = await race((c) => cancel(c, cancelFirst), (c) => collect(c, cancelFirst))
      assert.equal(c1.ok, true)
      assert.match(String(c2.error?.message), /CLAIM_LOCAL_PICKUP_NOT_FOUND/)
      assert.equal((await db.query('select count(*)::int n from order_claim_local_pickups where claim_id=$1 and status=$2', [cancelFirst, 'cancelado'])).rows[0].n, 1)
      assert.equal((await db.query('select count(*)::int n from order_claim_local_pickups where claim_id=$1 and picked_up_at is not null', [cancelFirst])).rows[0].n, 0)

      const collectFirst = remember(await collectedClaim({ quantity: 1, collect: false }))
      const [k1, k2] = await race((c) => collect(c, collectFirst), (c) => cancel(c, collectFirst))
      assert.equal(k1.ok, true)
      assert.match(String(k2.error?.message), /CLAIM_LOCAL_PICKUP_ALREADY_COLLECTED/)
      assert.equal((await state(collectFirst)).pickup, 'retirado')
    })

    await t.test('6. dos reintentos simultáneos con la misma clave y el mismo contenido: un solo efecto, ambos ok', async () => {
      const claimId = remember(await collectedClaim({ quantity: 2 }))
      const key = randomUUID()
      const [first, second] = await race((c) => receive(c, claimId, 1, { key, note: 'Llegó una' }), (c) => receive(c, claimId, 1, { key, note: 'Llegó una' }))
      assert.deepEqual([first.ok, second.ok], [true, true])
      assert.deepEqual(await state(claimId), { pickup: 'recibido_parcial', units: 'con_cliente:1,recibida_beyonix:1', receptions: 1, losses: 0 })
      const lossKey = randomUUID()
      const results = await simultaneous((c) => loss(c, claimId, 1, { key: lossKey }), (c) => loss(c, claimId, 1, { key: lossKey }))
      assert.deepEqual(results.map((result) => result.ok), [true, true])
      assert.deepEqual(await state(claimId), { pickup: 'resuelto_con_perdida', units: 'perdida_traslado:1,recibida_beyonix:1', receptions: 1, losses: 1 })
    })

    await t.test('7. misma clave con contenido distinto en paralelo: conflicto explícito, sin movimientos extra', async () => {
      const claimId = remember(await collectedClaim({ quantity: 3 }))
      const key = randomUUID()
      const [first, second] = await race((c) => receive(c, claimId, 1, { key }), (c) => receive(c, claimId, 2, { key }))
      assert.equal(first.ok, true)
      assert.match(String(second.error?.message), /CLAIM_LOGISTICS_IDEMPOTENCY_CONFLICT/)
      // Misma clave, mismo contenido, otro Admin: tampoco es un reintento.
      await assert.rejects(receive(b, claimId, 1, { key, actor: admin2 }), /CLAIM_LOGISTICS_IDEMPOTENCY_CONFLICT/)
      assert.deepEqual(await state(claimId), { pickup: 'recibido_parcial', units: 'con_cliente:2,recibida_beyonix:1', receptions: 1, losses: 0 })
    })

    await t.test('8. recepción parcial seguida de pérdida definitiva (otra conexión): cierre trazable sin stock artificial', async () => {
      const claimId = remember(await collectedClaim({ quantity: 2 }))
      const before = await stock()
      await receive(a, claimId, 1, { note: 'Llegó una sola' })
      assert.equal((await state(claimId)).pickup, 'recibido_parcial')
      await loss(b, claimId, 1, { note: 'Confirmado con el cadete: el paquete se extravió' })
      assert.deepEqual(await state(claimId), { pickup: 'resuelto_con_perdida', units: 'perdida_traslado:1,recibida_beyonix:1', receptions: 1, losses: 1 })
      assert.equal(await stock(), before)
      await assert.rejects(inspect(db, claimId, 2), /CLAIM_LOCAL_PICKUP_NOT_RECEIVED/)
      await inspect(db, claimId, 1)
      assert.equal(await stock(), before + 1)
      assert.equal((await db.query('select order_claim_money_block($1) b', [claimId])).rows[0].b, null)
      // Ningún backend quedó esperando (sin deadlocks ni locks colgados).
      const waiting = (await db.query("select count(*)::int n from pg_stat_activity where wait_event_type='Lock'")).rows[0].n
      assert.equal(waiting, 0)
    })

    // N1: cancelación / cierre en carrera con la pérdida y con la resolución comercial.
    const claimRow = async (claimId) => (await db.query('select status, cancelled_at, updated_at::text v from order_claims where id=$1', [claimId])).rows[0]
    const cancelClaim = async (client, claimId, version) =>
      client.query("select applied from cancel_order_claim($1,$2,$3::timestamptz,'El cliente desistió del reclamo')", [claimId, admin, version])

    await t.test('9. pérdida y cancelación simultáneas: la cancelación espera el lock y se rechaza (nunca queda cancelado sin solución)', async () => {
      const claimId = remember(await collectedClaim({ quantity: 1 }))
      const { v } = await claimRow(claimId)
      const [lost, cancelled] = await race((c) => loss(c, claimId, 1), (c) => cancelClaim(c, claimId, v))
      assert.equal(lost.ok, true)
      assert.equal(cancelled.ok, false)
      // La pérdida tocó el reclamo (CAS) o la cancelación vio la pérdida: en ambos casos, rechazada.
      assert.match(String(cancelled.error.message), /CLAIM_CANCEL_BLOCKED|CLAIM_CONFLICT/)
      const fresh = await claimRow(claimId)
      assert.equal(fresh.cancelled_at, null)
      const retry = await settle(cancelClaim(b, claimId, fresh.v))
      assert.match(String(retry.error?.message), /CLAIM_CANCEL_BLOCKED/)
      assert.match(String(retry.error?.detail), /transit_loss_pending/)
      await assert.rejects(b.query("update order_claims set status='cerrado', closed_at=now(), cancelled_at=now(), cancelled_by=$2, cancellation_reason='Cancelación forzada directa' where id=$1", [claimId, admin]),
        /CLAIM_CANCEL_TRANSIT_LOSS/)
      assert.equal((await claimRow(claimId)).status, 'reintegro_pendiente')
    })

    await t.test('10. resolución en curso y cierre simultáneos: el cierre espera y se rechaza hasta que el reintegro se liquide', async () => {
      const claimId = remember(await collectedClaim({ quantity: 1 }))
      await loss(db, claimId, 1)
      const item = itemOf(claimId)
      const issueNote = async (c) => {
        const note = (await c.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount) values($1,$2,'processing','external_refund',1000) returning id", [item, claimId])).rows[0].id
        await c.query('insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,$2,1,1000,1000)', [note, item])
        return note
      }
      const close = (c) => c.query("update order_claims set status='cerrado' where id=$1", [claimId])
      const [issued, closed] = await race(issueNote, close)
      assert.equal(issued.ok, true)
      assert.match(String(closed.error?.message), /CLAIM_TRANSIT_LOSS_UNRESOLVED/)
      // Marcado liquidado sin dinero persistido: tampoco alcanza.
      await db.query("update order_credit_notes set status='authorized', cae='CAE-9', settlement_status='completado' where id=$1", [issued.value])
      await assert.rejects(close(b), /CLAIM_TRANSIT_LOSS_UNRESOLVED/)
      // Liquidado de verdad (comprobante del reintegro): recién ahí se finaliza; cancelar sigue prohibido.
      const proof = (await db.query("insert into order_refund_proofs(order_id,amount,method) values($1,1000,'Reintegro manual') returning id", [item])).rows[0].id
      await db.query('update order_credit_notes set settlement_reference=$2 where id=$1', [issued.value, String(proof)])
      const { v } = await claimRow(claimId)
      const cancelAfter = await settle(cancelClaim(a, claimId, v))
      assert.match(String(cancelAfter.error?.detail), /transit_loss_resolved/)
      await close(b)
      assert.deepEqual([(await claimRow(claimId)).status, (await claimRow(claimId)).cancelled_at], ['cerrado', null])
      const waiting = (await db.query("select count(*)::int n from pg_stat_activity where wait_event_type='Lock'")).rows[0].n
      assert.equal(waiting, 0)
    })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
