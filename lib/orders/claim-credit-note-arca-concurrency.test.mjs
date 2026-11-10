import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// NC de reclamo con la cadena fiscal REAL (ARCA, liquidación MP, guardas de CAE y
// de 20261106120000) en PostgreSQL REAL con dos backends: autorizaciones
// simultáneas, autorización vs cambio de asociación, liquidación vs cambio
// fiscal y reintentos concurrentes de la conciliación. ARCA no se contacta.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const migration = (name) => read(`../../supabase/migrations/${name}.sql`)

// Igual que CLAIM_FISCAL_CHAIN (fixtures/claim-financial-db.ts), en orden cronológico.
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
  '20260924140000_order_claim_customer_reads',
  '20260924150000_claim_product_change_requires_replacement',
  '20260924160000_claim_resolution_summary_notifications',
  '20260927110000_arca_credit_note_hardening',
  '20260927120000_arca_environment_isolation',
  '20260928100000_claim_andreani_shipments',
  '20260930100000_claim_logistics_branch_only',
  '20261001100000_claim_logistics_hardening',
  '20261001120000_reopen_rejected_order_claim',
  '20261001130000_cancel_order_claim',
  '20261001170000_claim_return_dropoff_copy',
  '20261015120000_settle_credit_notes_after_mp_refund',
  '20261015170000_mercadopago_refund_closure',
  '20261015180000_fiscal_obligation_guards',
  '20261019120000_claim_policy_consolidation',
  '20261020100000_claim_item_resolutions',
  '20261020110000_claim_item_return_obligation',
  '20261106110000_dispatch_records_carrier_filter',
  '20261106120000_claim_local_pickups',
]

const customer = '53000000-0000-4000-8000-000000000001'
const admin = '53000000-0000-4000-8000-000000000003'
const ENV = 'homologation'
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
const IMMUTABLE = /CREDIT_NOTE_AUTHORIZED_IMMUTABLE|CREDIT_NOTE_CAE_IMMUTABLE/

test('NC de reclamo + ARCA: concurrencia con PostgreSQL real', { timeout: 300000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-claim-credit-note-arca-pg')
  const clients = []
  const errors = []
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
    assert.deepEqual(CHAIN, [...CHAIN].sort(), 'orden cronológico')
    await server.initialise(); await server.start()
    // UTF8 explícito: en Windows el cluster embebido nace en WIN1252.
    await (await connect('postgres')).query("create database beyonix encoding 'UTF8' template template0")
    const db = await connect()
    await db.query(read('./fixtures/claim-logistics-schema.sql'))
    await db.query('alter table ordenes add column shipping_provider text, add column envio_proveedor text')
    await db.query(read('./fixtures/claim-fiscal-schema.sql'))
    for (const name of CHAIN) await db.query(migration(name))
    for (const [id, role] of [[customer, 'cliente'], [admin, 'admin']]) {
      await db.query('insert into auth.users values($1,$2,now())', [id, `${id}@example.test`])
      await db.query('insert into profiles(id,email,rol) values($1,$2,$3)', [id, `${id}@example.test`, role])
    }
    await db.query('insert into productos(id) values(1); insert into producto_variantes(id,producto_id) values(1,1)')
    await db.query("select adjust_variant_stock_idempotent(1,40,'seed de test',$1,'seed-claim-arca-1')", [admin])
    const a = await connect()
    const b = await connect()

    let orderId = 0
    let voucher = 800
    const record = (result) => { if (!result.ok) errors.push(result.error); return result }
    /** Reclamo de reintegro parcial con una NC en proceso por $2.000, ya con su número pedido a ARCA. */
    async function requestedNote() {
      orderId += 1
      await db.query(`insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type,shipping_provider,payment_id,
          invoice_status,invoice_point,invoice_number,invoice_cae,invoice_arca_environment,invoice_queued_at)
        values($1,$2,'entregado',now()-interval '1 day','payment_confirmed',90000,'domicilio','beyonix',$3,'authorized',3,100+$1::bigint,'CAE-F'||$1::text,$4,now())`,
      [orderId, customer, `pay-${orderId}`, ENV])
      await db.query('insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values($1,$1,1,1,1,30000)', [orderId])
      const op = randomUUID()
      await db.query("select begin_order_claim_operation($1,$2,$3,$4,'{}','order-claim-evidence')", [op, customer, orderId, randomUUID().replaceAll('-', '').repeat(2)])
      const claimId = Number((await db.query("select commit_customer_order_claim($1,$2,$3,'[]') as id",
        [op, customer, JSON.stringify({ problemType: 'falla', message: 'El producto dejó de funcionar.', items: [{ order_item_id: orderId, quantity: 1 }] })])).rows[0].id)
      const version = (await db.query('select updated_at::text v from order_claims where id=$1', [claimId])).rows[0].v
      await db.query('select mutate_admin_order_claim($1,$2,$3,$4)', [claimId, admin, version, JSON.stringify({ status: 'reintegro_pendiente', resolution: 'reintegro_parcial' })])
      await db.query('begin')
      const note = (await db.query(`insert into order_credit_notes(order_id,claim_id,status,destination,reason,items_amount,manual_amount,total_amount,external_amount,invoice_point,invoice_number,settlement_status)
        values($1,$2,'processing','external_refund','Reintegro parcial acordado',2000,0,2000,2000,3,100+$1::bigint,'pendiente') returning id`, [orderId, claimId])).rows[0].id
      await db.query('insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,$2,1,2000,2000)', [note, orderId])
      await db.query('commit')
      voucher += 1
      await db.query('select * from claim_credit_note_arca($1)', [note])
      await db.query("select * from record_credit_note_request($1,4,$2,2000,'20261110',$3)", [note, voucher, ENV])
      return { claimId, order: orderId, note, number: voucher }
    }
    const authorize = (client, { note, number }, cae = `CAE-NC-${number}`) =>
      client.query("select status, cae from complete_credit_note_authorization($1,4,$2,$3,'2026-11-20',now(),false,$4)", [note, number, cae, ENV])
    const confirmRefund = (client, order, amount = 2000) =>
      client.query("insert into mercadopago_order_refunds(order_id,payment_id,amount,status,mp_refund_id,idempotency_key,requested_by,completed_at) values($1,$2,$3,'confirmed',$4,$5,$6,now())",
        [order, `pay-${order}`, amount, `mp-${randomUUID().slice(0, 8)}`, randomUUID(), admin])
    const note = async (id) => (await db.query('select status, cae, claim_id, reason, total_amount, settlement_status from order_credit_notes where id=$1', [id])).rows[0]
    const authorizedEvents = async (id) => Number((await db.query("select count(*)::int n from order_audit_events where action='credit_note_arca_authorized' and metadata->>'orderCreditNoteId'=$1", [id])).rows[0].n)

    const waitUntilBlocked = async (client) => {
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const row = (await db.query('select wait_event_type from pg_stat_activity where pid=$1', [client.processID])).rows[0]
        if (row?.wait_event_type === 'Lock') return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.fail('la segunda transacción nunca esperó el lock')
    }
    const race = async (first, second) => {
      await a.query('begin')
      const firstResult = record(await settle(first(a)))
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

    await t.test('1. dos autorizaciones simultáneas con la misma respuesta: una autoriza, la otra es idempotente', async () => {
      const n = await requestedNote()
      const [first, second] = await race((c) => authorize(c, n), (c) => authorize(c, n))
      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      assert.equal(second.value.rows[0].status, 'authorized')
      assert.equal(await authorizedEvents(n.note), 1)
    })

    await t.test('2. dos autorizaciones simultáneas con CAE distinto: la segunda se rechaza y el CAE no cambia', async () => {
      const n = await requestedNote()
      const [first, second] = await race((c) => authorize(c, n), (c) => authorize(c, n, 'CAE-OTRO'))
      assert.equal(first.ok, true)
      assert.match(String(second.error?.message), /CREDIT_NOTE_ALREADY_AUTHORIZED_WITH_OTHER_VOUCHER/)
      assert.equal((await note(n.note)).cae, `CAE-NC-${n.number}`)
    })

    await t.test('3. autorización vs desvincular / cambiar motivo: esperan y se rechazan', async () => {
      const n = await requestedNote()
      const [first, unlink] = await race((c) => authorize(c, n), (c) => c.query('update order_credit_notes set claim_id=null where id=$1', [n.note]))
      assert.equal(first.ok, true)
      assert.match(String(unlink.error?.message), IMMUTABLE)
      const m = await requestedNote()
      const [second, rewrite] = await race((c) => authorize(c, m), (c) => c.query("update order_credit_notes set reason='Motivo reescrito' where id=$1", [m.note]))
      assert.equal(second.ok, true)
      assert.match(String(rewrite.error?.message), IMMUTABLE)
      assert.deepEqual([Number((await note(n.note)).claim_id), (await note(m.note)).reason], [n.claimId, 'Reintegro parcial acordado'])
    })

    await t.test('4. liquidación MP vs cambio fiscal (importe, asociación): esperan y se rechazan; el reclamo cierra con $2.000', async () => {
      const n = await requestedNote()
      await authorize(db, n)
      const [settled, reduced] = await race((c) => confirmRefund(c, n.order),
        (c) => c.query('update order_credit_notes set total_amount=1000, items_amount=1000, external_amount=1000 where id=$1', [n.note]))
      assert.equal(settled.ok, true)
      assert.match(String(reduced.error?.message), IMMUTABLE)
      assert.match(String((await settle(b.query('update order_credit_notes set claim_id=null where id=$1', [n.note]))).error?.message), IMMUTABLE)
      const row = await note(n.note)
      assert.deepEqual([row.settlement_status, Number(row.total_amount)], ['completado', 2000])
      await b.query("update order_claims set status='cerrado', closed_at=now() where id=$1", [n.claimId])
      assert.equal((await db.query('select status from order_claims where id=$1', [n.claimId])).rows[0].status, 'cerrado')
    })

    await t.test('5. conciliaciones MP concurrentes (reintentos): una liquida, la otra no; sin asignaciones dobles', async () => {
      const n = await requestedNote()
      await authorize(db, n)
      // Refund confirmado sin liquidar todavía (como si el webhook hubiera llegado antes del trigger).
      await db.query("insert into mercadopago_order_refunds(order_id,payment_id,amount,status,mp_refund_id,idempotency_key,requested_by) values($1,$2,2000,'processing','mp-late',$3,$4)",
        [n.order, `pay-${n.order}`, randomUUID(), admin])
      const [first, second] = await race(
        (c) => c.query("update mercadopago_order_refunds set status='confirmed', completed_at=now() where order_id=$1", [n.order]),
        (c) => c.query('select settle_credit_notes_after_mercadopago_refund($1) n', [n.order]))
      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      assert.equal(Number(second.value.rows[0].n), 0, 'ya liquidada por la primera')
      assert.equal((await note(n.note)).settlement_status, 'completado')
      const allocations = (await db.query('select count(*)::int n, sum(amount) s from order_credit_note_refund_allocations where credit_note_id=$1', [n.note])).rows[0]
      assert.deepEqual([allocations.n, Number(allocations.s)], [1, 2000])
    })

    await t.test('sin deadlocks ni esperas colgadas', async () => {
      assert.equal(errors.filter((error) => error?.code === '40P01').length, 0, 'ningún deadlock')
      assert.equal(errors.filter((error) => /statement timeout|lock timeout/i.test(String(error?.message))).length, 0)
      const waiting = (await db.query("select count(*)::int n from pg_stat_activity where wait_event_type='Lock'")).rows[0].n
      assert.equal(waiting, 0)
    })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await stopIsolatedPostgres(server, databaseDir)
  }
})
