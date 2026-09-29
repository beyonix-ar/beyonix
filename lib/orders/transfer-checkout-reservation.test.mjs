import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Fase 4 (transferencias) sobre PostgreSQL real con conexiones concurrentes:
// las RPC reales de reservas (Fases 1 y 3), de conciliación de transferencias
// (lease, claims de payment.id, conflicto de stock) y la migración de esta
// fase, apiladas en el orden real. El stock derivado se simula con un trigger
// AFTER que descuenta productos.stock al pasar a un estado que consume stock
// (igual efecto que refresh_inventory_stock sobre inventory_movements).

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const extract = (path, pattern) => {
  const match = read(path).match(pattern)?.[0]
  assert.ok(match, `no se encontró la función en ${path}`)
  return match
}
const available = extract('../../supabase/migrations/20260903150000_checkout_stock_reservation_window.sql',
  /create or replace function public\.available_stock_for_session\([\s\S]*?\n\$\$;/)
const decrement = extract('../inventory/fixtures/inventory-hardening-functions.sql',
  /create or replace function public\.decrement_checkout_inventory\([\s\S]*?\$function\$;/)
const consumes = extract('../../supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql',
  /create or replace function public\.inventory_order_consumes_stock\([\s\S]*?\$function\$;/)
const release = extract('../../supabase/migrations/20260801095000_stock_reservations.sql',
  /create or replace function public\.release_order_stock_reservation\([\s\S]*?\n\$\$;/)
const physicalGuard = extract('../../supabase/migrations/20260730174000_sellable_conditioned_variants.sql',
  /create or replace function public\.validate_inventory_order_confirmation\(\)[\s\S]*?\n\$\$;/)

const MIGRATIONS = [
  '../../supabase/migrations/20260925120000_checkout_step_stock_reservations.sql',
  '../../supabase/migrations/20260925130000_mercadopago_checkout_reservation_commit.sql',
  '../../supabase/migrations/20260913120000_transfer_auto_verification.sql',
  '../../supabase/migrations/20260914090000_transfer_auto_verification_amount_lock_and_stock_claim.sql',
  '../../supabase/migrations/20260914100000_transfer_verification_lease_and_payment_claims.sql',
  '../../supabase/migrations/20260926100000_transfer_checkout_reservation_window.sql',
  '../../supabase/migrations/20260926110000_retire_legacy_30_minute_checkout_reservation.sql',
  '../../supabase/migrations/20260926120000_transfer_payment_after_cancellation.sql',
]

test('Fase 4: transferencia sobre la reserva única de 20 minutos (PostgreSQL real)', { timeout: 240000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-transfer-reservation')
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
    await db.query(`alter table ordenes
      add column payment_method_id text, add column payment_confirmed_at timestamptz,
      add column cliente_email text, add column cliente_nombre text, add column financial_status text,
      add column total numeric, add column external_amount_due numeric, add column paid_at timestamptz,
      add column payment_confirmed_by uuid, add column payment_confirmed_amount numeric,
      add column order_change_status text, add column order_change_extra_amount numeric,
      add column cancelled_at timestamptz, add column refund_pending_at timestamptz`)
    await db.query('alter table order_audit_events add column previous_status text, add column new_status text')
    await db.query("create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$")
    await db.query(available); await db.query(decrement); await db.query(consumes)
    await db.query('create function public.complete_cart_stock_reservation(text,bigint) returns void language sql as $$ select $$')
    await db.query("create function public.validate_checkout_inventory_reservation(jsonb,text,bigint) returns jsonb language sql as $$ select '{}'::jsonb $$")
    await db.query(release)
    await db.query('create trigger release_order_stock_reservation after update of estado, payment_status or delete on ordenes for each row execute function public.release_order_stock_reservation()')
    await db.query(physicalGuard)
    await db.query('create trigger validate_inventory_order_confirmation before update of estado, payment_status on ordenes for each row execute function public.validate_inventory_order_confirmation()')
    await db.query(`create function test_simulate_inventory_refresh() returns trigger language plpgsql as $$
      begin
        if not inventory_order_consumes_stock(old.estado, old.payment_status)
           and inventory_order_consumes_stock(new.estado, new.payment_status) then
          update productos p set stock = p.stock - i.quantity
          from (select producto_id, sum(cantidad)::integer quantity from orden_items
                where orden_id = new.id group by 1) i
          where p.id = i.producto_id;
        end if;
        return new;
      end $$`)
    await db.query('create trigger zz_simulate_inventory_refresh after update of estado, payment_status on ordenes for each row execute function test_simulate_inventory_refresh()')
    for (const migration of MIGRATIONS) await db.query(read(migration))

    const a = await connect(); const b = await connect()
    let sequence = 0
    let paymentSequence = 0
    const product = async (stock) => (await db.query('insert into productos(stock) values($1) returning id', [stock])).rows[0].id
    const setup = async (productIds, { key = `transfer-phase4-${++sequence}-aaaaaaaa`, method = 'transferencia' } = {}) => {
      const items = productIds.map((id) => ({ product_id: id, quantity: 1, variant_id: null, conditioned_stock_id: null }))
      const order = Number((await db.query(`insert into ordenes(payment_method_id,payment_status,checkout_idempotency_key,total,external_amount_due,cliente_email)
        values($1,'pendiente_comprobante',$2,900,900,'cliente@example.com') returning id`, [method, `checkout:${key}`])).rows[0].id)
      for (const item of items) await db.query('insert into orden_items(orden_id,producto_id,cantidad) values($1,$2,1)', [order, item.product_id])
      return { key, items, order }
    }
    const reserve = (client, x, key = x.key) => client.query('select reserve_cart_stock($1,$2) as result', [key,
      JSON.stringify(x.items.map((item) => ({ productId: item.product_id, quantity: item.quantity })))])
    const commit = async (client, x) => (await client.query(
      'select commit_checkout_step_reservation($1,$2,$3) as expiry', [JSON.stringify(x.items), x.key, x.order])).rows[0].expiry
    const session = async (x) => (await db.query('select * from checkout_reservation_sessions where session_id=$1', [x.key])).rows[0]
    // Mueve la reserva en el tiempo: "entró al Paso 3 hace N minutos".
    const age = (x, minutes) => db.query(`
      with s as (update checkout_reservation_sessions
        set reservation_started_at = now() - make_interval(secs => $2),
            expires_at = now() - make_interval(secs => $2) + interval '20 minutes'
        where session_id = $1 returning expires_at)
      update stock_reservations set expires_at = (select expires_at from s) where session_id = $1`, [x.key, minutes * 60])
    const stock = async (id) => (await db.query('select stock from productos where id=$1', [id])).rows[0].stock
    const orderRow = async (x) => (await db.query('select estado, payment_status, transfer_verification_status, transfer_verification_failure_reason from ordenes where id=$1', [x.order])).rows[0]
    const claim = async (client, x) => (await client.query(
      'select transfer_verification_lease_id from claim_transfer_verification_attempt($1)', [x.order])).rows[0].transfer_verification_lease_id
    const confirm = async (client, x, lease, paymentId = `pay-${++paymentSequence}`, paidAt = null) => (await client.query(
      `select estado, payment_status from confirm_transfer_auto_verification($1,$2,'money_transfer','account_money',900,'CUIL','20301112220','30111222',null,coalesce($4::timestamptz, now()),coalesce($4::timestamptz, now()),$3)`,
      [x.order, paymentId, lease, paidAt])).rows[0]
    const verify = async (client, x, paymentId, paidAt = null) => confirm(client, x, await claim(client, x), paymentId, paidAt)
    const lateAudit = async (x) => (await db.query(
      "select metadata from order_audit_events where order_id=$1 and action='transfer_confirmed_after_reservation_expiry'", [x.order])).rows

    await t.test('1-3. hereda el vencimiento del Paso 3: minuto 15 no renueva y un refresh devuelve el mismo expiresAt', async () => {
      const p = await product(2)
      const x = await setup([p])
      await reserve(a, x)
      const started = await session(x)
      assert.equal(started.expires_at - started.reservation_started_at, 20 * 60 * 1000)
      await age(x, 15)
      const original = (await session(x)).expires_at
      const expiry = await commit(a, x)
      assert.equal(expiry.getTime(), original.getTime(), 'elegir transferencia al minuto 15 no suma minutos')
      assert.ok(expiry.getTime() - Date.now() < 5 * 60 * 1000 + 5000)
      assert.equal((await commit(b, x)).getTime(), original.getTime(), 'refresh / doble click: mismo expiresAt')
      const rows = (await db.query('select expires_at, order_id from stock_reservations where session_id=$1', [x.key])).rows
      assert.equal(rows.length, 1)
      assert.equal(rows[0].expires_at.getTime(), original.getTime())
      assert.equal(Number(rows[0].order_id), x.order)
    })

    await t.test('7. minuto 20+: el flujo normal se rechaza sin atar filas ni abrir otra ventana', async () => {
      const x = await setup([await product(1)])
      await reserve(a, x); await age(x, 21)
      await assert.rejects(commit(a, x), /RESERVATION_EXPIRED/)
      assert.equal((await db.query('select count(*)::int n from stock_reservations where order_id=$1', [x.order])).rows[0].n, 0)
      const y = await setup([await product(1)])
      await reserve(a, y); await age(y, 19.5)
      await assert.rejects(commit(a, y), /RESERVATION_EXPIRED/, 'con menos de un minuto tampoco se compromete')
    })

    await t.test('la reserva sólo se ata a un pedido por transferencia de la misma sesión', async () => {
      const p = await product(1)
      const x = await setup([p])
      await reserve(a, x)
      const other = await setup([p], { key: `transfer-phase4-other-${++sequence}-aaaaaaaa` })
      await assert.rejects(a.query('select commit_checkout_step_reservation($1,$2,$3)', [JSON.stringify(x.items), x.key, other.order]), /INVALID_SESSION/)
      const mp = await setup([p], { key: x.key.replace('transfer', 'mp'), method: 'mercadopago' })
      await assert.rejects(a.query('select commit_checkout_step_reservation($1,$2,$3)', [JSON.stringify(x.items), x.key, mp.order]), /INVALID_SESSION/)
      await assert.rejects(a.query('select commit_checkout_step_reservation($1,$2,$3)', [JSON.stringify([]), x.key, x.order]), /CHECKOUT_ITEMS_INVALID/)
      await commit(a, x)
    })

    await t.test('8. el vencimiento libera el stock para otra compra', async () => {
      const p = await product(1)
      const x = await setup([p]); await reserve(a, x); await commit(a, x)
      const y = await setup([p])
      await assert.rejects(reserve(b, y), /OUT_OF_STOCK/)
      await age(x, 21)
      await reserve(b, y)
    })

    await t.test('5-6, 15. pago dentro de término (minuto 10 / 19): confirma, consume una vez y cierra la reserva', async () => {
      const p = await product(1)
      const x = await setup([p]); await reserve(a, x); await commit(a, x); await age(x, 19)
      const result = await verify(a, x)
      assert.deepEqual(result, { estado: 'pagado', payment_status: 'confirmado' })
      assert.equal(await stock(p), 0)
      assert.equal((await db.query('select count(*)::int n from stock_reservations where order_id=$1', [x.order])).rows[0].n, 0)
      assert.equal((await db.query("select count(*)::int n from order_audit_events where order_id=$1 and action='transfer_confirmed_after_reservation_expiry'", [x.order])).rows[0].n, 0)
      await assert.rejects(claim(b, x), /ALREADY_RESOLVED/, 'un reintento o el cron no vuelve a confirmar')
      assert.equal(await stock(p), 0)
    })

    await t.test('11, 16. pago tardío (minuto 25) con stock libre: readquiere bajo lock, confirma y queda auditado', async () => {
      const p = await product(1)
      const x = await setup([p]); await reserve(a, x); await commit(a, x); await age(x, 25)
      assert.deepEqual(await verify(a, x), { estado: 'pagado', payment_status: 'confirmado' })
      assert.equal(await stock(p), 0)
      const audit = (await db.query("select metadata from order_audit_events where order_id=$1 and action='transfer_confirmed_after_reservation_expiry'", [x.order])).rows
      assert.equal(audit.length, 1)
      assert.ok(audit[0].metadata.reservationExpiresAt)
    })

    await t.test('12-14. A vence, B compra la última unidad, A paga tarde: conflicto controlado, B conserva y nunca stock negativo', async () => {
      const p = await product(1)
      const x = await setup([p]); await reserve(a, x); await commit(a, x); await age(x, 21)
      const y = await setup([p]); await reserve(b, y); await commit(b, y)
      assert.deepEqual(await verify(b, y), { estado: 'pagado', payment_status: 'confirmado' })
      const paymentId = `late-${++paymentSequence}`
      const late = await verify(a, x, paymentId)
      assert.deepEqual(late, { estado: 'pendiente', payment_status: 'auto_verified_stock_conflict' })
      assert.equal(await stock(p), 0, 'nunca -1')
      assert.equal((await orderRow(y)).estado, 'pagado', 'B conserva su unidad')
      assert.equal((await orderRow(x)).transfer_verification_failure_reason, 'stock_conflict')
      assert.equal((await db.query('select order_id from transfer_verification_payment_claims where payment_id=$1', [paymentId])).rows[0].order_id, String(x.order),
        'el dinero recibido queda atado al pedido tardío, no se descarta')
    })

    await t.test('13. B sólo reservó (sin pagar): el pago tardío de A no le quita la unidad', async () => {
      const p = await product(1)
      const x = await setup([p]); await reserve(a, x); await commit(a, x); await age(x, 21)
      const y = await setup([p]); await reserve(b, y)
      assert.deepEqual(await verify(a, x), { estado: 'pendiente', payment_status: 'auto_verified_stock_conflict' })
      await assert.rejects(db.query("update ordenes set estado='pagado', payment_status='confirmado' where id=$1", [x.order]), /CHECKOUT_STOCK_INSUFFICIENT/,
        'tampoco una confirmación manual directa')
      await commit(b, y)
      assert.deepEqual(await verify(b, y), { estado: 'pagado', payment_status: 'confirmado' })
      assert.equal(await stock(p), 0)
    })

    await t.test('14. dos pagos tardíos concurrentes por la última unidad: uno confirma, el otro queda en conflicto', async () => {
      const p = await product(1)
      const x1 = await setup([p]); await reserve(a, x1); await commit(a, x1); await age(x1, 21)
      const x2 = await setup([p]); await reserve(b, x2); await commit(b, x2); await age(x2, 21)
      const [lease1, lease2] = [await claim(a, x1), await claim(b, x2)]
      const results = await Promise.all([confirm(a, x1, lease1), confirm(b, x2, lease2)])
      assert.deepEqual(results.map((row) => row.payment_status).sort(), ['auto_verified_stock_conflict', 'confirmado'])
      assert.equal(await stock(p), 0)
    })

    await t.test('18-19. doble verify / cron + cliente concurrentes: un solo claim, una sola confirmación, un solo consumo', async () => {
      const p = await product(2)
      const x = await setup([p]); await reserve(a, x); await commit(a, x)
      const claims = await Promise.allSettled([claim(a, x), claim(b, x)])
      assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1)
      assert.match(String(claims.find((r) => r.status === 'rejected').reason), /ALREADY_CHECKING|RATE_LIMITED/)
      const lease = claims.find((r) => r.status === 'fulfilled').value
      const confirmations = await Promise.allSettled([confirm(a, x, lease, 'double-1'), confirm(b, x, lease, 'double-1')])
      assert.equal(confirmations.filter((r) => r.status === 'fulfilled').length, 1)
      assert.match(String(confirmations.find((r) => r.status === 'rejected').reason), /ALREADY_RESOLVED/)
      assert.equal(await stock(p), 1, 'consumió exactamente una unidad')
    })

    await t.test('17. una transferencia ya usada no acredita otro pedido', async () => {
      const x = await setup([await product(1)]); await reserve(a, x); await commit(a, x)
      await verify(a, x, 'used-once')
      const y = await setup([await product(1)]); await reserve(b, y); await commit(b, y)
      await assert.rejects(verify(b, y, 'used-once'), /TRANSFER_PAYMENT_ID_ALREADY_USED/)
      assert.equal((await orderRow(y)).estado, 'pendiente')
    })

    await t.test('A5. pagada en el minuto 19 según Mercado Pago pero detectada después: se registra en término, sin saltear el stock', async () => {
      const p = await product(2)
      const x = await setup([p]); await reserve(a, x); await commit(a, x); await age(x, 25)
      const expiresAt = (await session(x)).expires_at
      const paidAt = new Date(expiresAt.getTime() - 60_000).toISOString()
      assert.deepEqual(await verify(a, x, undefined, paidAt), { estado: 'pagado', payment_status: 'confirmado' })
      const [audit] = await lateAudit(x)
      assert.equal(audit.metadata.paidWithinReservation, true)
      assert.equal(new Date(audit.metadata.providerPaidAt).getTime(), new Date(paidAt).getTime())

      // Mismo caso, pero la última unidad ya la tiene otra compra: nunca se le quita.
      const q = await product(1)
      const late = await setup([q]); await reserve(a, late); await commit(a, late); await age(late, 25)
      const other = await setup([q]); await reserve(b, other)
      const lateExpiry = (await session(late)).expires_at
      assert.deepEqual(await verify(a, late, undefined, new Date(lateExpiry.getTime() - 60_000).toISOString()),
        { estado: 'pendiente', payment_status: 'auto_verified_stock_conflict' })
      await commit(b, other)
      assert.deepEqual(await verify(b, other), { estado: 'pagado', payment_status: 'confirmado' })
      assert.equal(await stock(q), 0)
    })

    await t.test('A3. saldo a favor: compromete la misma reserva sin renovarla y rechaza una vencida', async () => {
      const p = await product(1)
      const credit = await setup([p], { method: 'customer_credit' })
      await reserve(a, credit); await age(credit, 12)
      const original = (await session(credit)).expires_at
      assert.equal((await commit(a, credit)).getTime(), original.getTime(), 'no abre otros 30 minutos')
      await db.query("update ordenes set estado='pagado', payment_status='confirmado' where id=$1", [credit.order])
      assert.equal(await stock(p), 0)

      const expired = await setup([await product(1)], { method: 'customer_credit' })
      await reserve(a, expired); await age(expired, 21)
      await assert.rejects(commit(a, expired), /RESERVATION_EXPIRED/)
      assert.equal((await db.query('select count(*)::int n from stock_reservations where order_id=$1', [expired.order])).rows[0].n, 0)
    })

    await t.test('P2. transferencia real de un pedido cancelado sin pago: se registra, nunca se confirma ni se reutiliza', async () => {
      const p = await product(1)
      const old = await setup([p]); await reserve(b, old); await commit(b, old); await age(old, 25)
      // A informó al titular (monto que se le indicó: 700 tras aplicar saldo)
      // y después se canceló al iniciar un nuevo intento: el saldo se devolvió
      // y external_amount_due volvió al total.
      await db.query(`update ordenes set transfer_amount_declared=700, transfer_payer_dni='30111222',
        estado='cancelado', payment_status='checkout_superseded', financial_status='cancelled',
        cancelled_at=now(), external_amount_due=900 where id=$1`, [old.order])
      const record = (client, orderId, paymentId, amount = 700) => client.query(
        `select estado, payment_status, financial_status, transfer_verification_status, transfer_verification_failure_reason, transfer_matched_payment_id
         from record_transfer_payment_after_cancellation($1,$2,'money_transfer','account_money',$3,'CUIL','20301112220','30111222',null,now(),now())`,
        [orderId, paymentId, amount])

      await assert.rejects(record(b, old.order, 'late-a', 900), /AMOUNT_MISMATCH/, 'nunca contra el total ya sin saldo')
      const [first, second] = await Promise.all([record(a, old.order, 'late-a'), record(b, old.order, 'late-a')])
      for (const result of [first, second]) {
        assert.deepEqual(result.rows[0], {
          estado: 'cancelado', payment_status: 'approved_after_cancellation', financial_status: 'refund_pending',
          transfer_verification_status: 'manual_review', transfer_verification_failure_reason: 'paid_after_cancellation',
          transfer_matched_payment_id: 'late-a',
        })
      }
      assert.equal((await db.query("select count(*)::int n from order_audit_events where order_id=$1 and action='transfer_payment_after_cancellation'", [old.order])).rows[0].n, 1, 'idempotente')
      assert.equal((await db.query("select order_id from transfer_verification_payment_claims where payment_id='late-a'")).rows[0].order_id, String(old.order))
      assert.equal(await stock(p), 1, 'no consume stock')

      // El mismo payment.id nunca puede acreditar el pedido nuevo (B).
      const retry = await setup([p]); await reserve(b, retry); await commit(b, retry)
      await assert.rejects(verify(b, retry, 'late-a'), /TRANSFER_PAYMENT_ID_ALREADY_USED/)
      assert.equal((await orderRow(retry)).estado, 'pendiente')
      // Ni se puede "confirmar a ciegas" el pedido viejo.
      await assert.rejects(claim(b, old), /ORDER_CANCELLED|ALREADY_RESOLVED/)
      await assert.rejects(record(b, old.order, 'late-a-2'), /NOT_ELIGIBLE/, 'un segundo pago no pisa el registrado')
      // Sólo pedidos cancelados sin pago.
      await assert.rejects(record(b, retry.order, 'late-b'), /NOT_ELIGIBLE/)
    })

    await t.test('20. nuevo intento tras vencer: reserva y ventana nuevas, la vieja no revive', async () => {
      const p = await product(1)
      const x = await setup([p]); await reserve(a, x); await commit(a, x); await age(x, 21)
      await assert.rejects(reserve(a, x), /RESERVATION_LOCKED_TO_ORDER/, 'la sesión comprometida no se reabre')
      const retry = await setup([p])
      await reserve(a, retry)
      const expiry = await commit(a, retry)
      assert.ok(expiry.getTime() - Date.now() > 19 * 60 * 1000, 'intento nuevo = 20 minutos nuevos')
      const old = (await db.query('select order_id, expires_at from stock_reservations where session_id=$1', [x.key])).rows[0]
      assert.equal(Number(old.order_id), x.order)
      assert.ok(old.expires_at.getTime() < Date.now(), 'la reserva vieja sigue vencida y ligada a su pedido')
      assert.deepEqual(await verify(b, retry), { estado: 'pagado', payment_status: 'confirmado' })
      assert.deepEqual(await verify(a, x), { estado: 'pendiente', payment_status: 'auto_verified_stock_conflict' })
      assert.equal(await stock(p), 0)
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
