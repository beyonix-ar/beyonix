import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Antiabuso de reservas (20261029130000) sobre PostgreSQL real con varias
// conexiones: la RPC real de reserva (con el gate), la evaluación perezosa de
// faltas, el reset por compra (trigger en ordenes) y las acciones de Admin.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const extract = (path, pattern) => {
  const match = read(path).match(pattern)?.[0]
  assert.ok(match, `no se encontró la función en ${path}`)
  return match
}
const legacyAvailable = extract('../../supabase/migrations/20260903150000_checkout_stock_reservation_window.sql',
  /create or replace function public\.available_stock_for_session\([\s\S]*?\n\$\$;/)
const randomAvailable = extract('../../supabase/migrations/20261008120000_catalog_random_dual_color_barcode_aliases.sql',
  /create or replace function public\.available_stock_for_session\([\s\S]*?\n\$\$;/)
const consumes = extract('../../supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql',
  /create or replace function public\.inventory_order_consumes_stock\([\s\S]*?\$function\$;/)
const abuseMigration = read('../../supabase/migrations/20261029130000_reservation_abuse_protection.sql')

test('antiabuso de reservas (PostgreSQL real)', { timeout: 240000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-reservation-abuse-pg')
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
    await db.query(read('../inventory/fixtures/inventory-hardening-schema.sql'))
    await db.query("create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$")
    await db.query(legacyAvailable)
    await db.query('create function public.complete_cart_stock_reservation(text,bigint) returns void language sql as $$ select $$')
    await db.query("create function public.validate_checkout_inventory_reservation(jsonb,text,bigint) returns jsonb language sql as $$ select '{}'::jsonb $$")
    await db.query(read('../../supabase/migrations/20260925120000_checkout_step_stock_reservations.sql'))
    await db.query('alter table productos add column venta_aleatoria boolean not null default false')
    await db.query(randomAvailable)
    await db.query(consumes)
    await db.query(abuseMigration)

    const a = await connect(); const b = await connect()
    const admin = '00000000-0000-4000-8000-0000000000ad'
    await db.query('insert into auth.users(id) values ($1)', [admin])
    let nextUser = 0
    let nextSession = 0
    const user = async () => {
      const id = `10000000-0000-4000-8000-${String(++nextUser).padStart(12, '0')}`
      await db.query('insert into auth.users(id) values ($1)', [id])
      return id
    }
    const as = (client, userId) => client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ''])
    const session = () => `abuse-${++nextSession}-aaaaaaaa`
    const product = async (stock) => Number((await db.query('insert into productos(stock) values($1) returning id', [stock])).rows[0].id)
    const item = (productId, quantity) => ({ productId, quantity })
    const reserve = async (client, userId, key, items) => {
      await as(client, userId)
      return (await client.query('select reserve_cart_stock($1,$2) as result', [key, JSON.stringify(items)])).rows[0].result
    }
    const expire = (key) => db.query(`
      with s as (update checkout_reservation_sessions
        set reservation_started_at = now() - interval '21 minutes', expires_at = now() - interval '1 minute'
        where session_id = $1 returning expires_at)
      update stock_reservations set expires_at = (select expires_at from s) where session_id = $1`, [key])
    const evaluate = (client = db) => client.query('select evaluate_reservation_abuse()')
    const state = async (userId) => (await db.query('select * from reservation_abuse_states where user_id=$1', [userId])).rows[0]
    const strikes = async (userId) => (await state(userId))?.strike_count ?? 0
    const events = async (userId, type) => Number((await db.query(
      'select count(*)::int n from reservation_abuse_events where user_id=$1 and event_type=$2', [userId, type])).rows[0].n)
    const available = async (productId) => Number((await db.query(
      'select available_stock_for_session($1,null,null,null) as n', [productId])).rows[0].n)
    const sessionExists = async (key) => (await db.query(
      'select count(*)::int n from checkout_reservation_sessions where session_id=$1', [key])).rows[0].n === 1
    // Reserva grande que vacía stock y se abandona hasta vencer.
    const abandonLargeReservation = async (userId, units = 20) => {
      const key = session()
      await reserve(a, userId, key, [item(await product(units), units)])
      await expire(key)
      return key
    }
    const paidOrder = async (userId, key = null) => {
      const order = Number((await db.query(
        "insert into ordenes(usuario_id) values ($1) returning id", [userId])).rows[0].id)
      if (key) {
        await db.query('update checkout_reservation_sessions set order_id=$1 where session_id=$2', [order, key])
        await db.query('update stock_reservations set order_id=$1 where session_id=$2', [order, key])
      }
      return order
    }

    await t.test('A. 20 unidades + vacía stock + vence -> 1 falta (con la foto guardada al reservar)', async () => {
      const u = await user()
      const key = await abandonLargeReservation(u)
      const candidate = (await db.query('select * from reservation_abuse_candidates where session_id=$1', [key])).rows[0]
      assert.equal(candidate.reserved_units, 20)
      assert.equal(candidate.emptied_items.length, 1)
      await evaluate()
      assert.equal(await strikes(u), 1)
      assert.equal(await events(u, 'RESERVATION_ABUSE_STRIKE'), 1)
    })

    await t.test('A2. 8 + 7 de dos productos (15 en total) y uno queda en 0 -> también cuenta', async () => {
      const u = await user(); const key = session()
      await reserve(a, u, key, [item(await product(8), 8), item(await product(50), 7)])
      await expire(key); await evaluate()
      assert.equal(await strikes(u), 1)
    })

    await t.test('B/E-spec. 14 unidades que vacían stock -> 0 faltas', async () => {
      const u = await user(); const key = session()
      await reserve(a, u, key, [item(await product(14), 14)])
      await expire(key); await evaluate()
      assert.equal(await strikes(u), 0)
      assert.equal((await db.query('select count(*)::int n from reservation_abuse_candidates where session_id=$1', [key])).rows[0].n, 0)
    })

    await t.test('C. 20 unidades pero queda stock -> 0 faltas aunque abandone', async () => {
      const u = await user(); const key = session()
      await reserve(a, u, key, [item(await product(30), 20)])
      await expire(key); await evaluate()
      assert.equal(await strikes(u), 0)
    })

    await t.test('el vaciado se mide al reservar: si después otro repone o libera, igual cuenta', async () => {
      const u = await user(); const p = await product(20); const key = session()
      await reserve(a, u, key, [item(p, 20)])
      await db.query('update productos set stock = 100 where id=$1', [p])
      await expire(key); await evaluate()
      assert.equal(await strikes(u), 1)
    })

    await t.test('D/E. primera falta no bloquea; la segunda bloquea 7 días una sola vez', async () => {
      const u = await user()
      await abandonLargeReservation(u); await evaluate()
      assert.equal(await strikes(u), 1)
      const ok = await reserve(a, u, session(), [item(await product(5), 1)])
      assert.equal(ok.reserved, true, 'con 1 falta sigue reservando')

      await abandonLargeReservation(u)
      // El propio intento de reservar evalúa la falta pendiente y ya bloquea.
      const blocked = await reserve(b, u, session(), [item(await product(5), 1)])
      assert.equal(blocked.blocked, true)
      const s = await state(u)
      assert.equal(s.strike_count, 2)
      const days = (new Date(s.auto_blocked_until) - new Date(s.auto_blocked_at)) / 86_400_000
      assert.equal(days, 7)
      assert.equal(await events(u, 'AUTO_BLOCK_STARTED'), 1)
    })

    await t.test('F. bloqueado: rechazo antes de tocar stock, sin sesión ni filas nuevas', async () => {
      const u = await user()
      await abandonLargeReservation(u); await abandonLargeReservation(u); await evaluate()
      const p = await product(3); const key = session()
      const result = await reserve(a, u, key, [item(p, 3)])
      assert.deepEqual(result, { reserved: false, blocked: true })
      assert.equal(await available(p), 3)
      assert.equal(await sessionExists(key), false)
    })

    await t.test('G. vence el bloqueo de 7 días -> reserva otra vez y el contador vuelve a 0', async () => {
      const u = await user()
      await abandonLargeReservation(u); await abandonLargeReservation(u); await evaluate()
      await db.query("update reservation_abuse_states set auto_blocked_at = now() - interval '8 days', auto_blocked_until = now() - interval '1 day' where user_id=$1", [u])
      const result = await reserve(a, u, session(), [item(await product(5), 2)])
      assert.equal(result.reserved, true)
      assert.equal(await strikes(u), 0)
      assert.equal(await events(u, 'AUTO_BLOCK_EXPIRED'), 1)
      // Nuevo ciclo: una falta más no bloquea.
      await abandonLargeReservation(u); await evaluate()
      assert.equal(await strikes(u), 1)
      assert.equal((await state(u)).auto_blocked_until, null)
    })

    await t.test('H. reserva grande que termina pagada -> sin falta y contador en 0', async () => {
      const u = await user()
      await abandonLargeReservation(u); await evaluate()
      assert.equal(await strikes(u), 1)
      const key = session()
      await reserve(a, u, key, [item(await product(20), 20)])
      const order = await paidOrder(u, key)
      await db.query("update ordenes set estado='pagado', payment_status='confirmado' where id=$1", [order])
      await expire(key); await evaluate()
      assert.equal(await strikes(u), 0)
      assert.equal(await events(u, 'RESERVATION_ABUSE_STRIKE'), 1, 'la pagada no suma')
      const outcome = (await db.query('select outcome from reservation_abuse_candidates where session_id=$1', [key])).rows[0].outcome
      assert.equal(outcome, 'purchased')
      assert.equal(await events(u, 'STRIKES_RESET_AFTER_PURCHASE'), 1)
    })

    await t.test('I. tenía 1 falta y compra (pedido que nace pagado) -> 0; crear un pedido impago no resetea', async () => {
      const u = await user()
      await abandonLargeReservation(u); await evaluate()
      await db.query("insert into ordenes(usuario_id) values ($1)", [u])
      assert.equal(await strikes(u), 1, 'un pedido pendiente no es compra')
      await db.query("insert into ordenes(usuario_id, estado) values ($1, 'pagado')", [u])
      assert.equal(await strikes(u), 0)
    })

    await t.test('pedido cancelado sin pago -> falta; pedido todavía pendiente -> se espera', async () => {
      const u = await user(); const key = session()
      await reserve(a, u, key, [item(await product(20), 20)])
      const order = await paidOrder(u, key)
      await expire(key); await evaluate()
      assert.equal(await strikes(u), 0, 'pendiente: todavía puede pagarse')
      await db.query("update ordenes set estado='cancelado' where id=$1", [order])
      await evaluate()
      assert.equal(await strikes(u), 1)
    })

    await t.test('J. la misma expiración procesada dos veces (concurrente y repetida) -> 1 falta', async () => {
      const u = await user()
      await abandonLargeReservation(u)
      await Promise.all([evaluate(a), evaluate(b)])
      await evaluate()
      assert.equal(await strikes(u), 1)
      assert.equal(await events(u, 'RESERVATION_ABUSE_STRIKE'), 1)
    })

    await t.test('K. dos faltas distintas evaluadas a la vez -> contador 2 y un solo bloqueo', async () => {
      for (let round = 0; round < 3; round += 1) {
        const u = await user()
        await abandonLargeReservation(u); await abandonLargeReservation(u)
        await Promise.all([evaluate(a), evaluate(b), reserve(db, u, session(), [item(await product(5), 1)]).catch(() => null)])
        assert.equal(await strikes(u), 2)
        assert.equal(await events(u, 'AUTO_BLOCK_STARTED'), 1)
      }
      await as(db, null)
    })

    await t.test('L. bloqueo permanente: nunca reserva; no lo levantan compra ni vencimientos', async () => {
      const u = await user()
      await db.query("select admin_set_reservation_block($1,'block_permanent',$2,'Revisión manual')", [u, admin])
      assert.equal((await reserve(a, u, session(), [item(await product(5), 1)])).blocked, true)
      await db.query("insert into ordenes(usuario_id, estado) values ($1, 'pagado')", [u])
      await db.query("update reservation_abuse_states set auto_blocked_at = now() - interval '8 days', auto_blocked_until = now() - interval '1 day' where user_id=$1", [u])
      assert.equal((await reserve(a, u, session(), [item(await product(5), 1)])).blocked, true)
      assert.equal((await state(u)).manual_block, 'permanent')
      assert.equal(await events(u, 'PERMANENT_BLOCK'), 1)
    })

    await t.test('bloqueo manual de 7 días: bloquea y vence solo', async () => {
      const u = await user()
      await db.query("select admin_set_reservation_block($1,'block_7_days',$2,null)", [u, admin])
      assert.equal((await reserve(a, u, session(), [item(await product(5), 1)])).blocked, true)
      await db.query("update reservation_abuse_states set manual_blocked_until = now() - interval '1 minute' where user_id=$1", [u])
      assert.equal((await reserve(a, u, session(), [item(await product(5), 1)])).reserved, true)
      assert.equal(await events(u, 'MANUAL_BLOCK_EXPIRED'), 1)
    })

    await t.test('M. desbloqueo de Admin -> vuelve a reservar, sin faltas ni bloqueos', async () => {
      const u = await user()
      await abandonLargeReservation(u); await abandonLargeReservation(u)
      await db.query("select admin_set_reservation_block($1,'block_permanent',$2,null)", [u, admin])
      await db.query("select admin_set_reservation_block($1,'unblock',$2,'Cliente verificado')", [u, admin])
      assert.equal((await reserve(a, u, session(), [item(await product(5), 1)])).reserved, true)
      const s = await state(u)
      assert.equal(s.strike_count, 0)
      assert.equal(s.manual_block, null)
      assert.equal(s.auto_blocked_until, null)
      assert.equal(await events(u, 'MANUAL_UNBLOCK'), 1)
    })

    await t.test('N/O. IP bloqueada por Admin rechaza la reserva; desbloqueada vuelve a funcionar; sin IP no se bloquea', async () => {
      const u = await user(); const other = await user()
      const ip = '203.0.113.77'
      await db.query("select admin_set_reservation_ip_block($1::inet, true, $2, 'Actividad sospechosa')", [ip, admin])
      const key = session()
      await db.query('select register_checkout_reservation_client_ip($1,$2,$3::inet)', [key, u, ip])
      const p = await product(5)
      assert.equal((await reserve(a, u, key, [item(p, 1)])).blocked, true)
      assert.equal(await available(p), 5)
      const otherKey = session()
      await db.query('select register_checkout_reservation_client_ip($1,$2,$3::inet)', [otherKey, other, ip])
      assert.equal((await reserve(b, other, otherKey, [item(p, 1)])).blocked, true, 'misma IP, otra cuenta')
      assert.equal((await reserve(b, other, session(), [item(p, 1)])).reserved, true, 'sin IP registrada no hay bloqueo por IP')
      assert.equal(await strikes(u), 0, 'el bloqueo por IP nunca suma faltas')

      await db.query('select admin_set_reservation_ip_block($1::inet, false, $2, null)', [ip, admin])
      assert.equal((await reserve(a, u, key, [item(p, 1)])).reserved, true)
      const ipEvents = (await db.query("select event_type from reservation_abuse_events where client_ip=$1::inet order by id", [ip])).rows.map((r) => r.event_type)
      assert.deepEqual(ipEvents, ['IP_BLOCKED', 'IP_UNBLOCKED'])
    })

    await t.test('una sesión ajena no puede registrar IP sobre la sesión de otro usuario', async () => {
      const u = await user(); const other = await user(); const key = session()
      await db.query('select register_checkout_reservation_client_ip($1,$2,$3::inet)', [key, u, '198.51.100.1'])
      await db.query('select register_checkout_reservation_client_ip($1,$2,$3::inet)', [key, other, '198.51.100.2'])
      const row = (await db.query('select user_id, host(client_ip) ip from checkout_reservation_client_ips where session_id=$1', [key])).rows[0]
      assert.equal(row.user_id, u)
      assert.equal(row.ip, '198.51.100.1')
    })

    await t.test('reservar sin cuenta -> AUTH_REQUIRED sin tocar stock; liberar ([]) no exige el gate', async () => {
      const p = await product(5)
      await as(a, null)
      await assert.rejects(a.query('select reserve_cart_stock($1,$2)', [session(), JSON.stringify([item(p, 1)])]), /AUTH_REQUIRED/)
      assert.equal(await available(p), 5)
      const u = await user(); const key = session()
      await reserve(a, u, key, [item(p, 2)])
      await db.query("select admin_set_reservation_block($1,'block_permanent',$2,null)", [u, admin])
      await reserve(a, u, key, [])
      assert.equal(await available(p), 5, 'un bloqueado igual puede soltar lo que tenía')
    })

    await t.test('stock normal intacto: el gate no cambia disponibilidad ni sobreventa', async () => {
      const p = await product(10)
      const [x, y] = [await user(), await user()]
      const outcomes = await Promise.allSettled([
        reserve(a, x, session(), [item(p, 6)]),
        reserve(b, y, session(), [item(p, 6)]),
      ])
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1)
      assert.match(outcomes.find((r) => r.status === 'rejected').reason.message, /OUT_OF_STOCK/)
      assert.equal(await available(p), 4)
    })

    await t.test('roles de API: anon/authenticated no pueden ver tablas ni llamar funciones de Admin', async () => {
      const privileges = (await db.query(`
        select has_table_privilege('authenticated', 'public.reservation_abuse_states', 'SELECT') as states,
               has_table_privilege('anon', 'public.reservation_ip_blocks', 'SELECT') as ips,
               has_function_privilege('authenticated', 'public.admin_set_reservation_block(uuid,text,uuid,text)', 'EXECUTE') as block,
               has_function_privilege('authenticated', 'public.register_checkout_reservation_client_ip(text,uuid,inet)', 'EXECUTE') as ip,
               has_function_privilege('authenticated', 'public.reservation_abuse_gate(uuid,text)', 'EXECUTE') as gate
      `)).rows[0]
      assert.deepEqual(privileges, { states: false, ips: false, block: false, ip: false, gate: false })
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
