import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Postauditoría (Codex) con PostgreSQL REAL y dos backends independientes:
// reapertura de un rechazado (sólo por reopen_rejected_order_claim, una vez, con
// la autorización de SU transacción) y NC autorizada (importes congelados
// mientras otra sesión liquida o cierra). Rol service_role sin superusuario
// para la autorización.

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

const customer = '52000000-0000-4000-8000-000000000001'
const admin = '52000000-0000-4000-8000-000000000003'
const REASON = 'Me equivoqué: el reclamo sí corresponde'
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))

test('integridad de terminales y NC autorizadas bajo concurrencia', { timeout: 300000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-claim-terminal-integrity-pg')
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
    await server.initialise(); await server.start()
    // UTF8 explícito: en Windows el cluster embebido nace en WIN1252.
    await (await connect('postgres')).query("create database beyonix encoding 'UTF8' template template0")
    const db = await connect()
    await db.query(read('./fixtures/claim-logistics-schema.sql'))
    await db.query('alter table ordenes add column shipping_provider text, add column envio_proveedor text')
    await db.query("create table mercadopago_order_refunds(id uuid primary key default gen_random_uuid(), order_id bigint not null, payment_id text not null, amount numeric(12,2) not null check (amount > 0), status text not null default 'processing', mp_refund_id text, completed_at timestamptz)")
    for (const name of CHAIN) await db.query(migration(name))
    for (const [id, role] of [[customer, 'cliente'], [admin, 'admin']]) {
      await db.query('insert into auth.users values($1,$2,now())', [id, `${id}@example.test`])
      await db.query('insert into profiles(id,email,rol) values($1,$2,$3)', [id, `${id}@example.test`, role])
    }
    await db.query('insert into productos(id) values(1); insert into producto_variantes(id,producto_id) values(1,1)')
    await db.query("select adjust_variant_stock_idempotent(1,40,'seed de test',$1,'seed-terminal-integrity-1')", [admin])
    const a = await connect()
    const b = await connect()

    let orderId = 0
    let voucher = 7000
    const version = async (claimId) => (await db.query('select updated_at::text v from order_claims where id=$1', [claimId])).rows[0].v
    const mutate = async (claimId, patch) => db.query('select mutate_admin_order_claim($1,$2,$3,$4)', [claimId, admin, await version(claimId), JSON.stringify(patch)])
    const status = async (claimId) => (await db.query('select status from order_claims where id=$1', [claimId])).rows[0].status
    const record = (result) => { if (!result.ok) errors.push(result.error); return result }
    async function newClaim() {
      orderId += 1
      await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type,shipping_provider,payment_id) values($1,$2,'entregado',now()-interval '1 day','payment_confirmed',90000,'domicilio','beyonix',$3)", [orderId, customer, `pay-${orderId}`])
      await db.query('insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values($1,$1,1,1,1,30000)', [orderId])
      const op = randomUUID()
      await db.query("select begin_order_claim_operation($1,$2,$3,$4,'{}','order-claim-evidence')", [op, customer, orderId, randomUUID().replaceAll('-', '').repeat(2)])
      return Number((await db.query("select commit_customer_order_claim($1,$2,$3,'[]') as id",
        [op, customer, JSON.stringify({ problemType: 'falla', message: 'El producto dejó de funcionar.', items: [{ order_item_id: orderId, quantity: 1 }] })])).rows[0].id)
    }
    async function rejectedClaim() {
      const claimId = await newClaim()
      await mutate(claimId, { status: 'rechazado', resolution: 'rechazado', rejection_reason: 'No corresponde: daño por mal uso.' })
      return claimId
    }
    const reopen = (client, claimId, expected) =>
      client.query('select status from reopen_rejected_order_claim($1,$2,$3::timestamptz,$4)', [claimId, admin, expected, REASON])
    const directReopen = (client, claimId) =>
      client.query("update order_claims set status='en_revision', resolution=null, rejection_reason=null, closed_at=null, resolution_summary=null where id=$1", [claimId])

    /** B quedó esperando un lock (no pasó por delante de A). */
    const waitUntilBlocked = async (client) => {
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const row = (await db.query('select wait_event_type from pg_stat_activity where pid=$1', [client.processID])).rows[0]
        if (row?.wait_event_type === 'Lock') return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.fail('la segunda transacción nunca esperó el lock')
    }
    /** A ejecuta dentro de una transacción abierta; B arranca y queda bloqueada; A confirma (o revierte); B termina. */
    const race = async (first, second, end = 'commit') => {
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
      await a.query(end)
      return [firstResult, await pending]
    }

    await t.test('1. dos reaperturas simultáneas del mismo rechazado: una sola gana, la otra CLAIM_CONFLICT', async () => {
      const claimId = await rejectedClaim()
      const expected = await version(claimId)
      const [first, second] = await race((c) => reopen(c, claimId, expected), (c) => reopen(c, claimId, expected))
      assert.equal(first.ok, true)
      assert.match(String(second.error?.message), /CLAIM_CONFLICT/)
      assert.equal(await status(claimId), 'en_revision')
      const rows = (await db.query('select consumed_at from order_claim_reopen_authorizations where claim_id=$1', [claimId])).rows
      assert.equal(rows.length, 1)
      assert.ok(rows[0].consumed_at)
      assert.equal(Number((await db.query("select count(*)::int n from order_audit_events where action='claim_review_reopened' and (metadata->>'reason')=$1 and order_id=$2", [REASON, orderId])).rows[0].n), 1)
    })

    await t.test('2. la autorización de otra transacción nunca habilita un UPDATE directo (A revierte o confirma)', async () => {
      // A reabre legítimamente (su autorización vive en SU transacción) y revierte;
      // B, bloqueada en la fila, intenta el UPDATE directo con la forma exacta.
      const rolledBack = await rejectedClaim()
      const expected = await version(rolledBack)
      const [, afterRollback] = await race((c) => reopen(c, rolledBack, expected), (c) => directReopen(c, rolledBack), 'rollback')
      assert.match(String(afterRollback.error?.message), /CLAIM_REOPEN_UNAUTHORIZED/)
      assert.equal(await status(rolledBack), 'rechazado')
      assert.equal(Number((await db.query('select count(*)::int n from order_claim_reopen_authorizations where claim_id=$1', [rolledBack])).rows[0].n), 0)

      // Después de una reapertura confirmada y un nuevo rechazo, la autorización vieja no sirve.
      const reused = await rejectedClaim()
      await reopen(db, reused, await version(reused))
      await mutate(reused, { status: 'rechazado', resolution: 'rechazado', rejection_reason: 'No corresponde, revisado otra vez.' })
      assert.match(String((await settle(directReopen(b, reused))).error?.message), /CLAIM_REOPEN_UNAUTHORIZED/)
      assert.equal(await status(reused), 'rechazado')
    })
    await t.test('3. service_role (sin superusuario) no fabrica la autorización ni la lee', async () => {
      const claimId = await rejectedClaim()
      await b.query('set role service_role')
      try {
        assert.match(String((await settle(b.query('insert into order_claim_reopen_authorizations(claim_id,actor_id,reason) values($1,$2,$3)', [claimId, admin, REASON]))).error?.message), /permission denied/)
        assert.match(String((await settle(b.query('select * from order_claim_reopen_authorizations'))).error?.message), /permission denied/)
        await b.query("select set_config('beyonix.claim_reopen', $1, false)", [String(claimId)])
      } finally {
        await b.query('reset role')
      }
      assert.match(String((await settle(directReopen(b, claimId))).error?.message), /CLAIM_REOPEN_UNAUTHORIZED/)
      assert.equal(await status(claimId), 'rechazado')
    })

    /** Reintegro parcial con NC autorizada por $2.000. */
    async function partialRefund() {
      const claimId = await newClaim()
      await mutate(claimId, { status: 'reintegro_pendiente', resolution: 'reintegro_parcial' })
      voucher += 1
      await db.query('begin')
      const note = (await db.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,external_amount,settlement_status) values($1,$2,'processing','external_refund',2000,2000,'pendiente') returning id", [orderId, claimId])).rows[0].id
      await db.query('insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,$2,1,2000,2000)', [note, orderId])
      await db.query("update order_credit_notes set status='authorized', cae=$2, voucher_point=1, voucher_number=$3, authorized_at=now() where id=$1", [note, `CAE-${voucher}`, voucher])
      await db.query('commit')
      return { claimId, order: orderId, note }
    }
    const proof = async (client, order, amount) => (await client.query("insert into order_refund_proofs(order_id,amount,method) values($1,$2,'Reintegro manual') returning id", [order, amount])).rows[0].id
    const settleWith = (client, note, proofId) =>
      client.query("update order_credit_notes set settlement_status='completado', management_status='finalizada', settlement_reference=$2 where id=$1", [note, String(proofId)])
    const noteAmount = async (note) => Number((await db.query('select total_amount from order_credit_notes where id=$1', [note])).rows[0].total_amount)

    await t.test('4. liquidación legítima vs rebaja del importe: la rebaja espera y se rechaza; el reclamo cierra con el dinero completo', async () => {
      const { claimId, order, note } = await partialRefund()
      const proofId = await proof(db, order, 2000)
      const [settled, reduced] = await race((c) => settleWith(c, note, proofId),
        (c) => c.query('update order_credit_notes set total_amount=1000, items_amount=1000, external_amount=1000 where id=$1', [note]))
      assert.equal(settled.ok, true)
      assert.match(String(reduced.error?.message), /CREDIT_NOTE_AUTHORIZED_IMMUTABLE/)
      assert.equal(await noteAmount(note), 2000)
      await b.query("update order_claims set status='cerrado', closed_at=now() where id=$1", [claimId])
      assert.equal(await status(claimId), 'cerrado')
    })

    await t.test('5. rebaja + comprobante menor + cierre en otra sesión: nunca cierra falsamente', async () => {
      const { claimId, order, note } = await partialRefund()
      const small = await proof(db, order, 1000)
      const reduced = await settle(a.query('update order_credit_notes set total_amount=1000, items_amount=1000, external_amount=1000 where id=$1', [note]))
      assert.match(String(reduced.error?.message), /CREDIT_NOTE_AUTHORIZED_IMMUTABLE/)
      assert.match(String((await settle(settleWith(a, note, small))).error?.message), /CREDIT_NOTE_REFUND_EVIDENCE_EXHAUSTED/)
      assert.match(String((await settle(b.query("update order_claims set status='cerrado', closed_at=now() where id=$1", [claimId]))).error?.message), /CLAIM_REFUND_PENDING/)
      assert.equal(await status(claimId), 'reintegro_pendiente')
      assert.equal(await noteAmount(note), 2000)
    })

    await t.test('6. resumen de un reclamo finalizado vs cierre concurrente: congelado al confirmar', async () => {
      const { claimId, order, note } = await partialRefund()
      await settleWith(db, note, await proof(db, order, 2000))
      const [closed, rewritten] = await race((c) => c.query("update order_claims set status='cerrado', closed_at=now() where id=$1", [claimId]),
        (c) => c.query("update order_claims set resolution_summary='{\"label\":\"Reintegro de $ 999.999\"}' where id=$1", [claimId]))
      assert.equal(closed.ok, true)
      assert.match(String(rewritten.error?.message), /CLAIM_TERMINAL_IMMUTABLE/)
      assert.notEqual((await db.query('select resolution_summary->>\'label\' l from order_claims where id=$1', [claimId])).rows[0].l, 'Reintegro de $ 999.999')
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
