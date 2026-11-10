import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Pérdida en traslado (retiro por cadete) con PostgreSQL REAL y dos backends
// independientes: el cierre del reclamo frente a la liquidación del reintegro,
// la acreditación del saldo, la reducción de lo compensado, la reversión del
// crédito y el uso de la misma evidencia para otra cosa. Autoridad: el lock del
// reclamo (UPDATE del cierre / FOR SHARE de toda modificación de evidencia
// congelada) y la revalidación del cierre con lo ya confirmado.

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

const customer = '51000000-0000-4000-8000-000000000001'
const admin = '51000000-0000-4000-8000-000000000003'
const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
const UNRESOLVED = /CLAIM_TRANSIT_LOSS_UNRESOLVED/
const LOCKED = /CLAIM_COMPENSATION_EVIDENCE_LOCKED/

test('pérdida en traslado: cierre vs evidencia financiera concurrente', { timeout: 300000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-claim-transit-loss-compensation-pg')
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
    await db.query("select adjust_variant_stock_idempotent(1,40,'seed de test',$1,'seed-transit-loss-1')", [admin])
    const a = await connect()
    const b = await connect()

    let orderId = 0
    let voucher = 5000
    /** Pedido Envío BEYONIX (ítem = id del pedido) con 2 unidades retiradas por el cadete y perdidas en el traslado. */
    async function lostClaim({ resolution = 'reintegro_total', status = 'reintegro_pendiente' } = {}) {
      orderId += 1
      await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type,shipping_provider,payment_id) values($1,$2,'entregado',now()-interval '1 day','payment_confirmed',90000,'domicilio','beyonix',$3)", [orderId, customer, `pay-${orderId}`])
      await db.query('insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values($1,$1,1,1,2,30000)', [orderId])
      const op = randomUUID()
      await db.query("select begin_order_claim_operation($1,$2,$3,$4,'{}','order-claim-evidence')", [op, customer, orderId, randomUUID().replaceAll('-', '').repeat(2)])
      const claimId = Number((await db.query("select commit_customer_order_claim($1,$2,$3,'[]') as id",
        [op, customer, JSON.stringify({ problemType: 'falla', message: 'El producto dejó de funcionar.', items: [{ order_item_id: orderId, quantity: 2 }] })])).rows[0].id)
      const version = (await db.query('select updated_at::text v from order_claims where id=$1', [claimId])).rows[0].v
      await db.query('select mutate_admin_order_claim($1,$2,$3,$4)', [claimId, admin, version, JSON.stringify({ status, resolution })])
      await db.query("select * from request_order_claim_local_pickup($1,$2,'Coordinar')", [claimId, admin])
      await db.query("select * from mark_order_claim_local_pickup_collected($1,$2,'Retiró el cadete')", [claimId, admin])
      await db.query("select status from confirm_order_claim_local_pickup_loss($1,$2,$3,'El cadete perdió el paquete en el traslado',$4)",
        [claimId, admin, JSON.stringify([{ order_item_id: orderId, quantity: 2 }]), randomUUID()])
      return { claimId, orderId }
    }
    /** NC de reclamo autorizada (sin liquidar) por las 2 unidades. */
    async function authorizedNote({ claimId, orderId: order }, destination) {
      voucher += 1
      await db.query('begin')
      const note = (await db.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,settlement_status) values($1,$2,'processing',$3,2000,'pendiente') returning id",
        [order, claimId, destination])).rows[0].id
      await db.query('insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,$2,2,1000,2000)', [note, order])
      await db.query("update order_credit_notes set status='authorized', cae=$2, voucher_point=1, voucher_number=$3, authorized_at=now() where id=$1", [note, `CAE-${voucher}`, voucher])
      await db.query('commit')
      return { id: note, voucher: `0001-${String(voucher).padStart(8, '0')}` }
    }
    /** complete_manual_order_financial_refund: comprobante + NC liquidada con su id. */
    const settleWithProof = async (client, order, noteId, amount = 2000) => {
      const proof = (await client.query("insert into order_refund_proofs(order_id,amount,method) values($1,$2,'Reintegro manual') returning id", [order, amount])).rows[0].id
      await client.query("update order_credit_notes set settlement_status='completado', management_status='finalizada', settlement_reference=$2 where id=$1", [noteId, String(proof)])
      return proof
    }
    /** creditCustomerForOrderCreditNote + finalizeCreditNote. */
    const settleToBalance = async (client, { claimId, orderId: order }, note) => {
      const movement = (await client.query("insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,claim_id,credit_note_id,metadata,source_key) values($1,'credit',2000,'credit_note',$2,$3,$4,$5,$6) returning id",
        [customer, order, claimId, note.voucher, JSON.stringify({ order_credit_note_id: note.id }), `credit-note:${order}:1:${note.voucher}`])).rows[0].id
      await client.query("update order_credit_notes set settlement_status='completado', management_status='finalizada' where id=$1", [note.id])
      return movement
    }
    const close = (client, claimId) => client.query("update order_claims set status='cerrado', closed_at=now() where id=$1", [claimId])
    const status = async (claimId) => (await db.query('select status from order_claims where id=$1', [claimId])).rows[0].status
    const record = (result) => { if (!result.ok) errors.push(result.error); return result }

    /** B quedó esperando un lock (no pasó por delante de A). */
    const waitUntilBlocked = async (client) => {
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const row = (await db.query('select wait_event_type from pg_stat_activity where pid=$1', [client.processID])).rows[0]
        if (row?.wait_event_type === 'Lock') return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.fail('la segunda transacción nunca esperó el lock')
    }
    /** A ejecuta dentro de una transacción abierta; B arranca y queda bloqueada; A confirma; B termina. */
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
      return [firstResult, record(await pending)]
    }
    /** A deja la evidencia sin confirmar: B nunca la ve a medias; tras el commit, sí. */
    const uncommittedThenCommitted = async (produce, claimId) => {
      await a.query('begin')
      record(await settle(produce(a)))
      const early = record(await settle(close(b, claimId)))
      await a.query('commit')
      const late = record(await settle(close(b, claimId)))
      return [early, late]
    }

    await t.test('1. cierre vs liquidación del reintegro: sin la evidencia confirmada no cierra; confirmada, sí', async () => {
      const claim = await lostClaim()
      const note = await authorizedNote(claim, 'external_refund')
      const [early, late] = await uncommittedThenCommitted((c) => settleWithProof(c, claim.orderId, note.id), claim.claimId)
      assert.match(String(early.error?.message), UNRESOLVED)
      assert.equal(late.ok, true)
      assert.equal(await status(claim.claimId), 'cerrado')
    })

    await t.test('2. cierre vs acreditación de saldo: atómico, nunca con un crédito sin confirmar', async () => {
      const claim = await lostClaim({ resolution: 'saldo_a_favor', status: 'aprobado' })
      const note = await authorizedNote(claim, 'customer_balance')
      const [early, late] = await uncommittedThenCommitted((c) => settleToBalance(c, claim, note), claim.claimId)
      assert.match(String(early.error?.message), UNRESOLVED)
      assert.equal(late.ok, true)
      assert.equal(await status(claim.claimId), 'cerrado')
    })

    await t.test('3. cierre vs reducción de la cantidad compensada: después del cierre espera y se rechaza; antes, nunca se reduce', async () => {
      const closedFirst = await lostClaim()
      const n1 = await authorizedNote(closedFirst, 'external_refund')
      await settleWithProof(db, closedFirst.orderId, n1.id)
      const [closed, reduced] = await race((c) => close(c, closedFirst.claimId),
        (c) => c.query('update order_credit_note_items set quantity=1 where credit_note_id=$1', [n1.id]))
      assert.equal(closed.ok, true)
      assert.match(String(reduced.error?.message), LOCKED)
      assert.equal(Number((await db.query('select quantity from order_credit_note_items where credit_note_id=$1', [n1.id])).rows[0].quantity), 2)

      const reducedFirst = await lostClaim()
      const n2 = await authorizedNote(reducedFirst, 'external_refund')
      await settleWithProof(db, reducedFirst.orderId, n2.id)
      // Antes del cierre tampoco: los renglones de una NC autorizada son inmutables.
      const reduce = await settle(b.query('update order_credit_note_items set quantity=1 where credit_note_id=$1', [n2.id]))
      assert.match(String(reduce.error?.message), /CREDIT_NOTE_ITEMS_LOCKED/)
      await close(b, reducedFirst.claimId)
      assert.equal(await status(reducedFirst.claimId), 'cerrado')
    })

    await t.test('4. cierre vs reversión del crédito: nunca queda cerrado con el crédito revertido', async () => {
      const reverse = (movement, order) => (c) => c.query(
        "insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,related_movement_id,source_key) values($1,'debit',2000,'reversal',$2,$3,$4)",
        [customer, order, movement, `customer-credit:${movement}:admin-reversal`])

      const closedFirst = await lostClaim({ resolution: 'saldo_a_favor', status: 'aprobado' })
      const m1 = await settleToBalance(db, closedFirst, await authorizedNote(closedFirst, 'customer_balance'))
      const [closed, reversed] = await race((c) => close(c, closedFirst.claimId), reverse(m1, closedFirst.orderId))
      assert.equal(closed.ok, true)
      assert.match(String(reversed.error?.message), LOCKED)

      const reversedFirst = await lostClaim({ resolution: 'saldo_a_favor', status: 'aprobado' })
      const m2 = await settleToBalance(db, reversedFirst, await authorizedNote(reversedFirst, 'customer_balance'))
      const [rev, close2] = await race(reverse(m2, reversedFirst.orderId), (c) => close(c, reversedFirst.claimId))
      assert.equal(rev.ok, true)
      assert.match(String(close2.error?.message), UNRESOLVED)
      assert.equal(await status(reversedFirst.claimId), 'aprobado')
    })

    /** NC adicional autorizada (sin liquidar) del mismo reclamo, por `quantity` unidades. */
    async function extraNote({ claimId, orderId: order }, quantity, amount) {
      voucher += 1
      await db.query('begin')
      const note = (await db.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,settlement_status) values($1,$2,'processing','external_refund',$3,'pendiente') returning id",
        [order, claimId, amount])).rows[0].id
      await db.query('insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,$2,$3,$4,$4)', [note, order, quantity, amount])
      await db.query("update order_credit_notes set status='authorized', cae=$2, voucher_point=1, voucher_number=$3, authorized_at=now() where id=$1", [note, `CAE-${voucher}`, voucher])
      await db.query('commit')
      return note
    }
    const settleWith = (noteId, reference) => (c) =>
      c.query("update order_credit_notes set settlement_status='completado', management_status='finalizada', settlement_reference=$2 where id=$1", [noteId, reference])

    await t.test('5. dos liquidaciones simultáneas con el mismo comprobante: la segunda espera y se rechaza (capacidad)', async () => {
      const claim = await lostClaim()
      const n1 = await extraNote(claim, 1, 1000)
      const n2 = await extraNote(claim, 1, 1000)
      const proof = (await db.query("insert into order_refund_proofs(order_id,amount,method) values($1,1000,'Reintegro manual') returning id", [claim.orderId])).rows[0].id
      const [first, second] = await race(settleWith(n1, String(proof)), settleWith(n2, String(proof)))
      assert.equal(first.ok, true)
      assert.match(String(second.error?.message), /CREDIT_NOTE_REFUND_EVIDENCE_EXHAUSTED/)
      const used = (await db.query('select coalesce(sum(amount),0)::numeric total from order_credit_note_refund_allocations where refund_proof_id=$1', [proof])).rows[0].total
      assert.equal(Number(used), 1000, 'nunca más que el comprobante')
      // Con la capacidad consumida, el reclamo no cierra (falta una unidad) ni la evidencia se mueve.
      assert.match(String((await settle(close(b, claim.claimId))).error?.message), /CLAIM_TRANSIT_LOSS_UNRESOLVED/)
      assert.match(String((await settle(b.query('update order_refund_proofs set order_id=$2 where id=$1', [proof, claim.orderId + 1000]))).error?.message), /REFUND_EVIDENCE_ALLOCATED/)
    })

    await t.test('6. dos liquidaciones simultáneas con el mismo refund MP: la segunda espera y no consume nada; asignado, no se revierte', async () => {
      const claim = await lostClaim()
      const n1 = await extraNote(claim, 1, 2000)
      const n2 = await extraNote(claim, 1, 2000)
      const refund = (await db.query("insert into mercadopago_order_refunds(order_id,payment_id,amount,status,mp_refund_id,completed_at) values($1,$2,2000,'confirmed','mp-77',now()) returning id",
        [claim.orderId, `pay-${claim.orderId}`])).rows[0].id
      const [first, second] = await race(settleWith(n1, 'mp_refund:mp-77'), settleWith(n2, 'mp_refund:mp-77'))
      assert.equal(first.ok, true)
      // La confirmación MP no se revierte: la segunda NC no recibe dinero y queda auditada.
      assert.equal(second.ok, true)
      const allocated = (await db.query('select credit_note_id, amount::numeric amount from order_credit_note_refund_allocations where mercadopago_refund_id=$1', [refund])).rows
      assert.deepEqual(allocated.map((row) => [row.credit_note_id, Number(row.amount)]), [[n1, 2000]])
      // La segunda NC quedó autorizada sin dinero: el reintegro no se finaliza.
      assert.match(String((await settle(close(b, claim.claimId))).error?.message), /CLAIM_TRANSIT_LOSS_UNRESOLVED|CLAIM_REFUND_PENDING/)
      // El refund ya asignado no deja de estar confirmado.
      assert.match(String((await settle(b.query("update mercadopago_order_refunds set status='failed' where id=$1", [refund]))).error?.message), /REFUND_EVIDENCE_ALLOCATED/)
      assert.equal(await status(claim.claimId), 'reintegro_pendiente')
    })

    await t.test('7. dos créditos simultáneos para la misma NC: uno solo (índice único por UUID)', async () => {
      const claim = await lostClaim({ resolution: 'saldo_a_favor', status: 'aprobado' })
      const note = await authorizedNote(claim, 'customer_balance')
      const credit = (key) => (c) => c.query("insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,claim_id,credit_note_id,metadata,source_key) values($1,'credit',2000,'credit_note',$2,$3,$4,$5,$6)",
        [customer, claim.orderId, claim.claimId, note.voucher, JSON.stringify({ order_credit_note_id: note.id }), key])
      const [first, second] = await race(credit('retry-a'), credit('retry-b'))
      assert.equal(first.ok, true)
      assert.match(String(second.error?.message), /duplicate key|unique/i)
      const n = (await db.query("select count(*)::int n from customer_credit_movements where metadata->>'order_credit_note_id'=$1", [note.id])).rows[0].n
      assert.equal(n, 1)
    })

    await t.test('8. dos renglones simultáneos (una sola NC en proceso por pedido): reintento sin duplicado y nunca más que lo reclamado', async () => {
      const claim = await lostClaim()
      const note = (await db.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,settlement_status) values($1,$2,'processing','external_refund',2000,'pendiente') returning id",
        [claim.orderId, claim.claimId])).rows[0].id
      const addItem = (quantity) => (c) => c.query('insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,$2,$3,1000,$4)', [note, claim.orderId, quantity, 1000 * quantity])
      const [first, retry] = await race(addItem(2), addItem(2))
      assert.equal(first.ok, true)
      assert.match(String(retry.error?.message), /duplicate key|unique/i, 'el reintento concurrente no duplica')
      // Segunda NC del mismo pedido: nunca mientras otra está en proceso.
      const other = await settle(b.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,settlement_status) values($1,$2,'processing','external_refund',1000,'pendiente')", [claim.orderId, claim.claimId]))
      assert.match(String(other.error?.message), /duplicate key|unique/i)
      const units = (await db.query('select coalesce(sum(i.quantity),0)::int n from order_credit_note_items i join order_credit_notes n on n.id=i.credit_note_id where n.claim_id=$1', [claim.claimId])).rows[0].n
      assert.equal(units, 2)
    })

    await t.test('9. cierre vs re-vincular un débito existente al crédito del reclamo: nunca queda cerrado con su crédito revertido', async () => {
      const relink = (adjustment, credit) => (c) => c.query('update customer_credit_movements set related_movement_id=$2 where id=$1', [adjustment, credit])
      const adjustmentFor = async (key) => (await db.query("insert into customer_credit_movements(user_id,movement_type,amount,source_type,source_key) values($1,'debit',2000,'admin_adjustment',$2) returning id", [customer, key])).rows[0].id

      const closedFirst = await lostClaim({ resolution: 'saldo_a_favor', status: 'aprobado' })
      const c1 = await settleToBalance(db, closedFirst, await authorizedNote(closedFirst, 'customer_balance'))
      const a1 = await adjustmentFor('ajuste-9a')
      const [closed, relinked] = await race((c) => close(c, closedFirst.claimId), relink(a1, c1))
      assert.equal(closed.ok, true)
      assert.match(String(relinked.error?.message), LOCKED)

      const relinkedFirst = await lostClaim({ resolution: 'saldo_a_favor', status: 'aprobado' })
      const c2 = await settleToBalance(db, relinkedFirst, await authorizedNote(relinkedFirst, 'customer_balance'))
      const a2 = await adjustmentFor('ajuste-9b')
      const [rel, close2] = await race(relink(a2, c2), (c) => close(c, relinkedFirst.claimId))
      assert.equal(rel.ok, true)
      assert.match(String(close2.error?.message), UNRESOLVED, 'el cierre revalida con la reversión ya vinculada')
      assert.equal(await status(relinkedFirst.claimId), 'aprobado')
    })

    await t.test('10. cupón: cierre vs acreditación que completa el importe aprobado; antes del commit nunca cierra', async () => {
      orderId += 1
      await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type,shipping_provider,payment_id) values($1,$2,'entregado',now()-interval '1 day','payment_confirmed',90000,'domicilio','andreani',$3)", [orderId, customer, `pay-${orderId}`])
      await db.query('insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values($1,$1,1,1,1,30000)', [orderId])
      const op = randomUUID()
      await db.query("select begin_order_claim_operation($1,$2,$3,$4,'{}','order-claim-evidence')", [op, customer, orderId, randomUUID().replaceAll('-', '').repeat(2)])
      const claimId = Number((await db.query("select commit_customer_order_claim($1,$2,$3,'[]') as id",
        [op, customer, JSON.stringify({ problemType: 'falla', message: 'El producto dejó de funcionar.', items: [{ order_item_id: orderId, quantity: 1 }] })])).rows[0].id)
      const version = (await db.query('select updated_at::text v from order_claims where id=$1', [claimId])).rows[0].v
      await db.query('select mutate_admin_order_claim($1,$2,$3,$4)', [claimId, admin, version, JSON.stringify({ status: 'aprobado', resolution: 'cupon_descuento', credit_note_amount: 2000 })])
      const claim = { claimId, orderId }
      const couponNote = async () => {
        voucher += 1
        await db.query('begin')
        const note = (await db.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,settlement_status) values($1,$2,'processing','customer_balance',1000,'pendiente') returning id", [orderId, claimId])).rows[0].id
        await db.query("update order_credit_notes set status='authorized', cae=$2, voucher_point=1, voucher_number=$3, authorized_at=now() where id=$1", [note, `CAE-${voucher}`, voucher])
        await db.query('commit')
        return { id: note, voucher: `0001-${String(voucher).padStart(8, '0')}` }
      }
      const credit = (note) => async (c) => {
        await c.query("insert into customer_credit_movements(user_id,movement_type,amount,source_type,order_id,claim_id,credit_note_id,metadata,source_key) values($1,'credit',1000,'credit_note',$2,$3,$4,$5,$6)",
          [customer, orderId, claimId, note.voucher, JSON.stringify({ order_credit_note_id: note.id }), `credit-note:${orderId}:1:${note.voucher}:${note.id}`])
        await c.query("update order_credit_notes set settlement_status='completado' where id=$1", [note.id])
      }
      await credit(await couponNote())(db)
      const second = await couponNote()
      const [early, late] = await uncommittedThenCommitted(credit(second), claim.claimId)
      assert.match(String(early.error?.message), /CLAIM_CREDIT_PENDING/, '1000 de 2000 aprobados')
      assert.equal(late.ok, true)
      assert.equal(await status(claimId), 'cerrado')
      assert.match(String((await settle(b.query("update order_claims set resolution='otro' where id=$1", [claimId]))).error?.message), /CLAIM_TERMINAL_IMMUTABLE/)
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
