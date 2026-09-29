import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Cambio de método logístico (cambio directo <-> retiro) contra una reserva de
// reemplazo o una nota de crédito que llegan EN PARALELO, con PostgreSQL real
// y dos backends. La autoridad es request_order_claim_logistics: valida con el
// reclamo bloqueado, y reserva/NC toman ese mismo lock. Sin API de por medio.

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
]

const customer = '40000000-0000-4000-8000-000000000001'
const admin = '40000000-0000-4000-8000-000000000003'

test('cambio de método vs reserva / NC concurrentes: la base es la autoridad final', { timeout: 240000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-claim-method-pg')
  const clients = []
  const connect = async () => {
    const client = server.getPgClient('postgres', '127.0.0.1')
    await client.connect()
    clients.push(client)
    await client.query("set statement_timeout = '15s'")
    await client.query("set request.jwt.claim.role = 'service_role'")
    return client
  }

  try {
    await server.initialise(); await server.start()
    const db = await connect()
    await db.query(read('./fixtures/claim-logistics-schema.sql'))
    for (const name of CHAIN) await db.query(migration(name))
    for (const [id, role] of [[customer, 'cliente'], [admin, 'admin']]) {
      await db.query('insert into auth.users values($1,$2,now())', [id, `${id}@example.test`])
      await db.query('insert into profiles(id,email,rol) values($1,$2,$3)', [id, `${id}@example.test`, role])
    }
    await db.query('insert into productos(id) values(1); insert into producto_variantes(id,producto_id) values(1,1)')
    await db.query("select adjust_variant_stock_idempotent(1,50,'seed de test',$1,'seed-race-1')", [admin])
    const a = await connect()
    const b = await connect()

    let orderId = 0
    /** Pedido entregado + reclamo de cambio aprobado + cambio directo pendiente (sin operación Andreani). */
    async function exchangeClaim() {
      orderId += 1
      await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total) values($1,$2,'entregado',now()-interval '1 day','payment_confirmed',60000)", [orderId, customer])
      await db.query('insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values($1,$1,1,1,2,30000)', [orderId])
      const op = randomUUID()
      await db.query("select begin_order_claim_operation($1,$2,$3,$4,'{}','order-claim-evidence')", [op, customer, orderId, randomUUID().replaceAll('-', '').repeat(2)])
      const claimId = Number((await db.query("select commit_customer_order_claim($1,$2,$3,'[]') as id",
        [op, customer, JSON.stringify({ problemType: 'falla', message: 'El producto dejó de funcionar.', items: [{ order_item_id: orderId, quantity: 2 }] })])).rows[0].id)
      const version = (await db.query('select updated_at::text v from order_claims where id=$1', [claimId])).rows[0].v
      await db.query('select mutate_admin_order_claim($1,$2,$3,$4)', [claimId, admin, version, JSON.stringify({ status: 'aprobado', resolution: 'cambio_producto' })])
      await requestMethod(db, claimId, 'cambio')
      return claimId
    }
    const requestMethod = (client, claimId, direction) =>
      client.query("select id from request_order_claim_logistics($1,$2,$3,null,'4567','Sucursal Once','Av. Pueyrredón 100')", [claimId, admin, direction])
    const reserve = (client, claimId) =>
      client.query("select id from create_order_replacement($1,$1,1,2,'mismo_producto',$2,$3,null,null,$4)", [orderId, admin, randomUUID(), claimId])
    const creditNote = async (client, claimId, status = 'processing') => {
      await client.query("select register_claim_financial_exception($1,$2,'Excepción autorizada por gerencia')", [claimId, admin])
      await client.query('insert into order_credit_notes(order_id,claim_id,status,total_amount) values($1,$2,$3,1000)', [orderId, claimId, status])
    }
    const state = async (claimId) => (await db.query(
      `select (select string_agg(direction || ':' || status, ',' order by id) from order_claim_shipments where claim_id=$1) legs,
              (select count(*)::int from order_claim_units where claim_id=$1 and role='reemplazo' and location='reservada') reserved,
              (select count(*)::int from order_credit_notes where claim_id=$1 and status in ('processing','authorized')) notes`, [claimId])).rows[0]
    /** B quedó esperando el lock del reclamo (no pasó por delante de A). */
    const waitUntilBlocked = async (client) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const row = (await db.query("select wait_event_type from pg_stat_activity where pid=$1", [client.processID])).rows[0]
        if (row?.wait_event_type === 'Lock') return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.fail('la segunda transacción nunca esperó el lock del reclamo')
    }

    await t.test('sin API: la función rechaza cambiar de método con reserva o NC vigente (y no deja rastro)', async () => {
      const reserved = await exchangeClaim()
      await reserve(db, reserved)
      await assert.rejects(requestMethod(db, reserved, 'devolucion'), /CLAIM_LOGISTICS_RESERVATION_ACTIVE/)
      assert.deepEqual(await state(reserved), { legs: 'cambio:pendiente', reserved: 2, notes: 0 })

      const withNote = await exchangeClaim()
      await creditNote(db, withNote)
      await assert.rejects(requestMethod(db, withNote, 'devolucion'), /CLAIM_LOGISTICS_CREDIT_NOTE_ACTIVE/)
      assert.deepEqual(await state(withNote), { legs: 'cambio:pendiente', reserved: 0, notes: 1 })

      // Mismo método (reintento idempotente) sigue permitido; sin efectos, el cambio es libre.
      await requestMethod(db, withNote, 'cambio')
      const free = await exchangeClaim()
      await requestMethod(db, free, 'devolucion')
      assert.deepEqual(await state(free), { legs: 'cambio:cancelada,devolucion:pendiente', reserved: 0, notes: 0 })
    })

    await t.test('carrera: la reserva toma el lock primero -> el cambio de método espera y falla', async () => {
      const claimId = await exchangeClaim()
      await a.query('begin')
      await reserve(a, claimId)
      const change = requestMethod(b, claimId, 'devolucion').then(() => 'ok', (error) => error)
      await waitUntilBlocked(b)
      await a.query('commit')
      const outcome = await change
      assert.match(String(outcome?.message), /CLAIM_LOGISTICS_RESERVATION_ACTIVE/)
      assert.deepEqual(await state(claimId), { legs: 'cambio:pendiente', reserved: 2, notes: 0 })
    })

    await t.test('carrera: el cambio de método toma el lock primero -> la reserva espera y falla (sin plan de cambio)', async () => {
      const claimId = await exchangeClaim()
      await a.query('begin')
      await requestMethod(a, claimId, 'devolucion')
      const reservation = reserve(b, claimId).then(() => 'ok', (error) => error)
      await waitUntilBlocked(b)
      await a.query('commit')
      assert.match(String((await reservation)?.message), /REPLACEMENT_REQUIRES_PLAN/)
      assert.deepEqual(await state(claimId), { legs: 'cambio:cancelada,devolucion:pendiente', reserved: 0, notes: 0 })
    })

    await t.test('carrera: una NC nueva toma el lock primero -> el cambio de método espera y falla', async () => {
      const claimId = await exchangeClaim()
      await a.query('begin')
      await creditNote(a, claimId)
      const change = requestMethod(b, claimId, 'devolucion').then(() => 'ok', (error) => error)
      await waitUntilBlocked(b)
      await a.query('commit')
      assert.match(String((await change)?.message), /CLAIM_LOGISTICS_CREDIT_NOTE_ACTIVE/)
      assert.deepEqual(await state(claimId), { legs: 'cambio:pendiente', reserved: 0, notes: 1 })
    })

    await t.test('carrera: una NC en error que pasa a autorizada (UPDATE) también bloquea el cambio de método', async () => {
      const claimId = await exchangeClaim()
      await creditNote(db, claimId, 'error')
      await a.query('begin')
      await a.query("update order_credit_notes set status='authorized', cae='CAE-1' where claim_id=$1", [claimId])
      const change = requestMethod(b, claimId, 'devolucion').then(() => 'ok', (error) => error)
      await waitUntilBlocked(b)
      await a.query('commit')
      assert.match(String((await change)?.message), /CLAIM_LOGISTICS_CREDIT_NOTE_ACTIVE/)
      assert.deepEqual(await state(claimId), { legs: 'cambio:pendiente', reserved: 0, notes: 1 })
    })

    await t.test('si la reserva concurrente se revierte, el cambio de método (sin efectos) se aplica', async () => {
      const claimId = await exchangeClaim()
      await a.query('begin')
      await reserve(a, claimId)
      const change = requestMethod(b, claimId, 'devolucion').then(() => 'ok', (error) => error)
      await waitUntilBlocked(b)
      await a.query('rollback')
      assert.equal(await change, 'ok')
      assert.deepEqual(await state(claimId), { legs: 'cambio:cancelada,devolucion:pendiente', reserved: 0, notes: 0 })
    })

    // Cancelar reclamo (20261001130000): dos Admin a la vez y una reserva que llega en paralelo.
    const updatedAt = async (claimId) => (await db.query('select updated_at::text v from order_claims where id=$1', [claimId])).rows[0].v
    const cancel = async (client, claimId, version) =>
      (await client.query("select * from cancel_order_claim($1,$2,$3::timestamptz,'El cliente desistió del reclamo')", [claimId, admin, version])).rows[0]

    await t.test('dos Admin cancelan a la vez: uno aplica, el otro espera el lock y recibe el reclamo ya cancelado (sin duplicar)', async () => {
      const claimId = await exchangeClaim()
      const version = await updatedAt(claimId)
      await a.query('begin')
      const first = await cancel(a, claimId, version)
      const second = cancel(b, claimId, version).then((row) => row, (error) => error)
      await waitUntilBlocked(b)
      await a.query('commit')
      assert.deepEqual([first.applied, (await second).applied], [true, false])
      const audits = (await db.query("select count(*)::int n from order_audit_events where action='claim_cancelled' and metadata->>'claimId'=$1", [String(claimId)])).rows[0].n
      assert.equal(audits, 1)
      assert.equal((await db.query('select status from order_claims where id=$1', [claimId])).rows[0].status, 'cerrado')
    })

    await t.test('una reserva que toma el lock primero bloquea la cancelación (falla segura, reclamo intacto)', async () => {
      const claimId = await exchangeClaim()
      const version = await updatedAt(claimId)
      await a.query('begin')
      await reserve(a, claimId)
      const attempt = cancel(b, claimId, version).then((row) => row, (error) => error)
      await waitUntilBlocked(b)
      await a.query('commit')
      const outcome = await attempt
      // La reserva cambió el reclamo: o lo detecta el CAS o la guarda de efectos; nunca se cancela.
      assert.match(String(outcome?.message), /CLAIM_CANCEL_BLOCKED|CLAIM_CONFLICT/)
      assert.equal((await db.query('select status, cancelled_at from order_claims where id=$1', [claimId])).rows[0].cancelled_at, null)
      assert.equal((await state(claimId)).reserved, 2)
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
