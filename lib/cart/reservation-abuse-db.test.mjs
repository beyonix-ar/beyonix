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
    const session = () => `abuse-${++nextSession}-aaaaaaaa`
    const product = async (stock) => Number((await db.query('insert into productos(stock) values($1) returning id', [stock])).rows[0].id)
    const item = (productId, quantity) => ({ productId, quantity })
    // Camino de la app: el servidor (service_role) informa el usuario del JWT
    // validado y la IP de X-Real-IP.
    const reserve = async (client, userId, key, items, ip = null) =>
      (await client.query('select reserve_cart_stock($1,$2,$3,$4::inet) as result',
        [key, JSON.stringify(items), userId, ip])).rows[0].result
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

    const blockIp = (ip) => db.query("select admin_set_reservation_ip_block($1::inet, true, $2, 'Actividad sospechosa')", [ip, admin])
    const unblockIp = (ip) => db.query('select admin_set_reservation_ip_block($1::inet, false, $2, null)', [ip, admin])
    const touched = async (p, key) => ({ available: await available(p), session: await sessionExists(key) })

    await t.test('A/H. IP y usuario permitidos (servidor con identidad validada) -> reserva y registra la IP', async () => {
      const u = await user(); const p = await product(5); const key = session()
      const result = await reserve(a, u, key, [item(p, 2)], '198.51.100.10')
      assert.equal(result.reserved, true)
      assert.equal(await available(p), 3)
      const owner = (await db.query('select user_id from checkout_reservation_sessions where session_id=$1', [key])).rows[0].user_id
      assert.equal(owner, u, 'la sesión queda asociada al user_id real')
      const row = (await db.query('select user_id, host(client_ip) ip from checkout_reservation_client_ips where session_id=$1', [key])).rows[0]
      assert.deepEqual({ ...row }, { user_id: u, ip: '198.51.100.10' })
    })

    await t.test('B/N/O. IP bloqueada -> 0 reserva y 0 stock (también otra cuenta y IPv6); desbloqueada vuelve a funcionar', async () => {
      const u = await user(); const other = await user()
      const ip = '203.0.113.77'; const ipv6 = '2001:db8::77'
      await blockIp(ip); await blockIp(ipv6)
      const p = await product(5); const key = session()
      assert.deepEqual(await reserve(a, u, key, [item(p, 1)], ip), { reserved: false, blocked: true })
      assert.deepEqual(await touched(p, key), { available: 5, session: false })
      const otherKey = session()
      assert.equal((await reserve(b, other, otherKey, [item(p, 1)], ip)).blocked, true, 'misma IP, otra cuenta')
      assert.equal((await reserve(b, other, otherKey, [item(p, 1)], ipv6)).blocked, true, 'IPv6')
      assert.equal(await available(p), 5)
      assert.equal(await strikes(u), 0, 'el bloqueo por IP nunca suma faltas')

      await unblockIp(ip)
      assert.equal((await reserve(a, u, key, [item(p, 1)], ip)).reserved, true)
      const ipEvents = (await db.query("select event_type from reservation_abuse_events where client_ip=$1::inet order by id", [ip])).rows.map((r) => r.event_type)
      assert.deepEqual(ipEvents, ['IP_BLOCKED', 'IP_UNBLOCKED'])
      await unblockIp(ipv6)
    })

    await t.test('C/D. usuario bloqueado (IP permitida o bloqueada) -> 0 reserva y 0 stock', async () => {
      const u = await user(); const ip = '203.0.113.78'
      await db.query("select admin_set_reservation_block($1,'block_7_days',$2,null)", [u, admin])
      const p = await product(5); const key = session()
      assert.equal((await reserve(a, u, key, [item(p, 1)], '198.51.100.11')).blocked, true, 'IP permitida')
      await blockIp(ip)
      assert.equal((await reserve(a, u, key, [item(p, 1)], ip)).blocked, true, 'usuario e IP bloqueados')
      assert.deepEqual(await touched(p, key), { available: 5, session: false })
      await unblockIp(ip)
    })

    await t.test('E. sin IP: sólo rige el bloqueo de usuario; nunca se inventa IP, pero la última registrada de la sesión sigue valiendo', async () => {
      const u = await user(); const ip = '203.0.113.79'
      const p = await product(5)
      assert.equal((await reserve(a, u, session(), [item(p, 1)])).reserved, true, 'sin IP y usuario permitido')
      // Misma sesión: primero con IP (luego bloqueada), después una llamada sin IP.
      const key = session()
      assert.equal((await reserve(a, u, key, [item(p, 1)], ip)).reserved, true)
      await blockIp(ip)
      assert.equal((await reserve(a, u, key, [item(p, 2)])).blocked, true, 'usa la IP ya registrada para la sesión')
      await unblockIp(ip)
      const blockedUser = await user()
      await db.query("select admin_set_reservation_block($1,'block_permanent',$2,null)", [blockedUser, admin])
      assert.equal((await reserve(a, blockedUser, session(), [item(p, 1)])).blocked, true, 'sin IP el bloqueo de usuario sigue')
    })

    await t.test('bypass: otra cuenta "ocupa" el session_id con su IP; la IP bloqueada de esta llamada igual bloquea', async () => {
      const accomplice = await user(); const attacker = await user(); const ip = '203.0.113.80'
      await blockIp(ip)
      const key = session(); const p = await product(5)
      // La cuenta cómplice deja una fila de IP para ese session_id (queda bloqueada, sin sesión).
      assert.equal((await reserve(a, accomplice, key, [item(p, 1)], ip)).blocked, true)
      assert.equal((await reserve(b, attacker, key, [item(p, 1)], ip)).blocked, true)
      assert.deepEqual(await touched(p, key), { available: 5, session: false })
      const row = (await db.query('select user_id from checkout_reservation_client_ips where session_id=$1', [key])).rows[0]
      assert.equal(row.user_id, accomplice, 'una cuenta no reescribe la IP registrada de otra')
      await unblockIp(ip)
    })

    await t.test('F. sin usuario validado (JWT inválido -> p_user_id null) -> AUTH_REQUIRED sin tocar stock', async () => {
      const p = await product(5); const key = session()
      await assert.rejects(reserve(a, null, key, [item(p, 1)], '198.51.100.12'), /AUTH_REQUIRED/)
      assert.deepEqual(await touched(p, key), { available: 5, session: false })
    })

    await t.test('G. CRÍTICO: authenticated llamando la RPC directa (REST) no puede reservar ni saltar el gate de IP', async () => {
      const u = await user(); const ip = '203.0.113.81'
      await blockIp(ip)
      const p = await product(5); const key = session()
      // 1-3. Camino normal de la app (servidor con la IP de X-Real-IP): bloqueado.
      assert.equal((await reserve(a, u, key, [item(p, 1)], ip)).blocked, true)

      // 4. Igual que PostgREST con el JWT del usuario: rol authenticated.
      const asAuthenticated = async (sql, params) => {
        await b.query('begin')
        try {
          await b.query('set local role authenticated')
          await b.query("select set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claim.sub', $1, true)", [u])
          return await b.query(sql, params)
        } finally {
          await b.query('rollback')
        }
      }
      const items = JSON.stringify([item(p, 1)])
      await assert.rejects(asAuthenticated('select reserve_cart_stock($1,$2,$3,$4::inet)', [key, items, u, null]),
        /permission denied for function reserve_cart_stock/, 'sin EXECUTE aunque omita o falsifique la IP')
      await assert.rejects(asAuthenticated('select reserve_cart_stock($1,$2,$3,$4::inet)', [key, items, u, '198.51.100.99']),
        /permission denied for function reserve_cart_stock/, 'no puede elegir su propia IP')
      await assert.rejects(asAuthenticated('select reserve_cart_stock($1,$2)', [key, items]),
        /function reserve_cart_stock\(unknown, unknown\) does not exist/, 'la firma vieja (auth.uid()) ya no existe')

      // Defensa adicional: aun con EXECUTE, un JWT que no es service_role no pasa.
      await b.query('begin')
      try {
        await b.query("select set_config('request.jwt.claim.role', 'authenticated', true)")
        await assert.rejects(b.query('select reserve_cart_stock($1,$2,$3,$4::inet)', [key, items, u, null]), /INVALID_SESSION/)
      } finally {
        await b.query('rollback')
      }
      assert.deepEqual(await touched(p, key), { available: 5, session: false })
      await unblockIp(ip)
    })

    await t.test('I. liberar ([]) sigue funcionando aunque usuario e IP estén bloqueados; otra cuenta no libera', async () => {
      const u = await user(); const other = await user(); const ip = '203.0.113.82'
      const p = await product(5); const key = session()
      await reserve(a, u, key, [item(p, 2)], ip)
      assert.equal(await available(p), 3)
      await blockIp(ip)
      await db.query("select admin_set_reservation_block($1,'block_permanent',$2,null)", [u, admin])
      await assert.rejects(reserve(b, other, key, []), /INVALID_SESSION/)
      await assert.rejects(reserve(b, null, key, []), /INVALID_SESSION/, 'sin usuario no libera una sesión con dueño')
      assert.equal(await available(p), 3)
      const released = await reserve(a, u, key, [])
      assert.equal(released.reserved, false)
      assert.equal(await available(p), 5, 'un bloqueado igual puede soltar lo que tenía')
      await unblockIp(ip)
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

    await t.test('roles de API: anon/authenticated no pueden ver tablas, reservar ni llamar funciones internas o de Admin', async () => {
      const privileges = (await db.query(`
        select has_table_privilege('authenticated', 'public.reservation_abuse_states', 'SELECT') as states,
               has_table_privilege('anon', 'public.reservation_ip_blocks', 'SELECT') as ips,
               has_table_privilege('authenticated', 'public.checkout_reservation_client_ips', 'INSERT') as ip_write,
               has_function_privilege('authenticated', 'public.admin_set_reservation_block(uuid,text,uuid,text)', 'EXECUTE') as block,
               has_function_privilege('authenticated', 'public.reservation_abuse_gate(uuid,text,inet)', 'EXECUTE') as gate,
               has_function_privilege('anon', 'public.reserve_cart_stock(text,jsonb,uuid,inet)', 'EXECUTE') as reserve_anon,
               has_function_privilege('authenticated', 'public.reserve_cart_stock(text,jsonb,uuid,inet)', 'EXECUTE') as reserve_authenticated,
               has_function_privilege('service_role', 'public.reserve_cart_stock(text,jsonb,uuid,inet)', 'EXECUTE') as reserve_service,
               to_regprocedure('public.reserve_cart_stock(text,jsonb)') is null as legacy_dropped,
               to_regprocedure('public.register_checkout_reservation_client_ip(text,uuid,inet)') is null as register_dropped
      `)).rows[0]
      assert.deepEqual(privileges, {
        states: false, ips: false, ip_write: false, block: false, gate: false,
        reserve_anon: false, reserve_authenticated: false, reserve_service: true,
        legacy_dropped: true, register_dropped: true,
      })
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
