import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import EmbeddedPostgres from 'embedded-postgres'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const oldMigration = read('../../supabase/migrations/20260903150000_checkout_stock_reservation_window.sql')
const availableFunction = oldMigration.match(/create or replace function public\.available_stock_for_session\([\s\S]*?\n\$\$;/)?.[0]
assert.ok(availableFunction)

test('Paso 3: reservas PostgreSQL reales, dos conexiones y transacciones', { timeout: 180000 }, async (t) => {
  const socket = createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const databaseDir = mkdtempSync(join(tmpdir(), 'beyonix-reservation-pg-'))
  const server = new EmbeddedPostgres({ databaseDir, port, user: 'postgres', password: 'isolated-test',
    persistent: true, postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} })
  const clients = []
  const connect = async () => {
    const client = server.getPgClient('postgres', '127.0.0.1')
    await client.connect()
    clients.push(client)
    await client.query("set statement_timeout = '10s'")
    await client.query("set request.jwt.claim.role = 'service_role'")
    return client
  }
  try {
    await server.initialise(); await server.start()
    const db = await connect()
    await db.query(read('../inventory/fixtures/inventory-hardening-schema.sql'))
    await db.query("create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$")
    await db.query(availableFunction)
    await db.query('create function public.complete_cart_stock_reservation(text,bigint) returns void language sql as $$ select $$')
    await db.query("create function public.validate_checkout_inventory_reservation(jsonb,text,bigint) returns jsonb language sql as $$ select '{}'::jsonb $$")
    await db.query(`
      insert into productos(id,stock) overriding system value values (9001,3),(9002,3);
      insert into ordenes(id) overriding system value values (9001);
      insert into stock_reservations(session_id,product_id,quantity,created_at,expires_at)
      values ('legacy-step-session',9001,1,now()-interval '5 minutes',now()+interval '25 minutes');
      insert into stock_reservations(session_id,product_id,quantity,order_id,created_at,expires_at)
      values ('legacy-bound-session',9002,1,9001,now()-interval '40 minutes',now()+interval '10 minutes');
    `)
    await db.query(read('../../supabase/migrations/20260925120000_checkout_step_stock_reservations.sql'))
    const a = await connect(); const b = await connect()
    let nextSession = 0
    const session = () => `checkout-step-${++nextSession}-aaaaaaaa`
    const product = async (stock, variants = []) => {
      const id = (await db.query('insert into productos(stock) values($1) returning id', [stock])).rows[0].id
      const ids = []
      for (const quantity of variants) ids.push((await db.query(
        'insert into producto_variantes(producto_id,stock) values($1,$2) returning id', [id, quantity])).rows[0].id)
      return { id, variants: ids }
    }
    const item = (p, quantity, variantId = null) => ({ productId: p.id, variantId, quantity })
    const reserve = async (client, key, items) => client.query('select reserve_cart_stock($1,$2) as result', [key, JSON.stringify(items)])
    const count = async (p, variantId = null) => Number((await db.query(
      'select coalesce(sum(quantity),0)::integer as n from stock_reservations where product_id=$1 and variant_id is not distinct from $2 and expires_at>now()',
      [p.id, variantId])).rows[0].n)
    const available = async (p, variantId = null) => Number((await db.query(
      'select available_stock_for_session($1,$2,null,null) as n', [p.id, variantId])).rows[0].n)
    const code = (error) => error.message.match(/OUT_OF_STOCK|INVALID_QUANTITY|INVALID_VARIANT|RESERVATION_EXPIRED|RESERVATION_LOCKED_TO_ORDER|INVALID_SESSION/)?.[0]

    await t.test('migración: acorta sólo reservas previas y conserva compromisos existentes', async () => {
      const rows = (await db.query(`select r.session_id, r.expires_at, s.reservation_started_at, s.expires_at as session_expires_at, s.order_id
        from stock_reservations r join checkout_reservation_sessions s using(session_id)
        where r.session_id like 'legacy-%' order by r.session_id`)).rows
      assert.equal(rows.length, 2)
      assert.equal(rows[0].session_id, 'legacy-bound-session')
      assert.equal(Number(rows[0].order_id), 9001)
      assert.ok(new Date(rows[0].expires_at) > new Date())
      assert.equal(rows[1].session_id, 'legacy-step-session')
      assert.equal(new Date(rows[1].session_expires_at) - new Date(rows[1].reservation_started_at), 20 * 60_000)
      assert.equal(new Date(rows[1].expires_at).getTime(), new Date(rows[1].session_expires_at).getTime())
    })

    await t.test('1: stock=1, dos clientes simultáneos: uno gana', async () => {
      const p = await product(1); const x = session(); const y = session()
      const bPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid
      await a.query('begin')
      try {
        await reserve(a, x, [item(p, 1)])
        const second = reserve(b, y, [item(p, 1)]).then(() => null, (error) => error)
        let blocked = false
        for (let i = 0; i < 100; i += 1) {
          blocked = (await db.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [bPid])).rows[0].blocked
          if (blocked) break
          await delay(10)
        }
        assert.equal(blocked, true, 'B debe esperar el advisory lock de A')
        await a.query('commit')
        assert.equal(code(await second), 'OUT_OF_STOCK')
      } finally {
        await a.query('rollback')
      }
      assert.equal(await count(p), 1); assert.equal(await available(p), 0)
    })
    await t.test('2: stock=2, dos sesiones reservan 1 cada una', async () => {
      const p = await product(2)
      await Promise.all([reserve(a, session(), [item(p, 1)]), reserve(b, session(), [item(p, 1)])])
      assert.equal(await count(p), 2); assert.equal(await available(p), 0)
    })
    await t.test('3: 2 contra 1 concurrentes nunca exceden stock=2', async () => {
      const p = await product(2)
      const results = await Promise.allSettled([reserve(a, session(), [item(p, 2)]), reserve(b, session(), [item(p, 1)])])
      assert.ok(results.some((r) => r.status === 'fulfilled'))
      assert.ok(await count(p) <= 2); assert.ok(await available(p) >= 0)
    })
    await t.test('4: carrito multi-item falla completo, sin parcial nuevo', async () => {
      const p = await product(1); const q = await product(0); const key = session()
      await assert.rejects(reserve(a, key, [item(p, 1), item(q, 1)]), /OUT_OF_STOCK/)
      assert.equal(await count(p), 0)
      assert.equal((await db.query('select count(*)::integer as n from checkout_reservation_sessions where session_id=$1', [key])).rows[0].n, 0)
      const existingKey = session()
      await reserve(a, existingKey, [item(p, 1)])
      await assert.rejects(reserve(a, existingKey, [item(p, 1), item(q, 1)]), /OUT_OF_STOCK/)
      assert.equal(await count(p), 1, 'la reserva previa también sobrevive al rollback')
    })
    await t.test('5: variantes independientes', async () => {
      const p = await product(5, [0, 4])
      await assert.rejects(reserve(a, session(), [item(p, 1, p.variants[0])]), /OUT_OF_STOCK/)
      await reserve(b, session(), [item(p, 1, p.variants[1])])
      assert.equal(await available(p, p.variants[0]), 0)
      assert.equal(await available(p, p.variants[1]), 3)
    })
    await t.test('6-7: 4, cero, negativos, fracciones y líneas repetidas >3', async () => {
      const p = await product(10)
      for (const quantity of [4, 0, -1, 1.5, 'x']) {
        await assert.rejects(reserve(a, session(), [item(p, quantity)]), /INVALID_QUANTITY/)
      }
      await assert.rejects(reserve(a, session(), [item(p, 2), item(p, 2)]), /INVALID_QUANTITY/)
    })
    await t.test('8-10: bajar cantidad, cambiar variante y eliminar ítem', async () => {
      const p = await product(7, [3, 4]); const q = await product(1); const key = session()
      await reserve(a, key, [item(p, 3, p.variants[0]), item(q, 1)])
      await reserve(a, key, [item(p, 1, p.variants[0]), item(q, 1)])
      assert.equal(await count(p, p.variants[0]), 1)
      await reserve(a, key, [item(p, 1, p.variants[1])])
      assert.equal(await count(p, p.variants[0]), 0)
      assert.equal(await count(p, p.variants[1]), 1)
      assert.equal(await count(q), 0)
      await reserve(a, key, [])
      assert.equal(await count(p, p.variants[1]), 0)
    })
    await t.test('11-12: 20 minutos fijos, retry no renueva y vencida vuelve al stock', async () => {
      const p = await product(1); const key = session()
      const first = (await reserve(a, key, [item(p, 1)])).rows[0].result
      assert.equal(new Date(first.expires_at) - new Date(first.reservation_started_at), 20 * 60_000)
      const second = (await reserve(a, key, [item(p, 1)])).rows[0].result
      assert.equal(second.expires_at, first.expires_at)
      await db.query("update checkout_reservation_sessions set reservation_started_at=now()-interval '21 minutes', expires_at=now()-interval '1 minute' where session_id=$1", [key])
      await db.query("update stock_reservations set expires_at=now()-interval '1 minute' where session_id=$1", [key])
      assert.equal(await available(p), 1)
      await assert.rejects(reserve(a, key, [item(p, 1)]), /RESERVATION_EXPIRED/)
    })
    await t.test('13: reserva vinculada a orden no se puede reemplazar ni liberar', async () => {
      const p = await product(2); const key = session()
      await reserve(a, key, [item(p, 1)])
      await db.query('insert into ordenes default values')
      const orderId = (await db.query('select max(id) as id from ordenes')).rows[0].id
      await db.query('update stock_reservations set order_id=$1 where session_id=$2', [orderId, key])
      await assert.rejects(reserve(a, key, [item(p, 2)]), /RESERVATION_LOCKED_TO_ORDER/)
      await assert.rejects(db.query('select release_cart_stock_reservation($1)', [key]), /RESERVATION_LOCKED_TO_ORDER/)
      await assert.rejects(db.query('select validate_checkout_inventory_reservation($1,$2,$3)', ['[]', key, Number(orderId) + 1]), /RESERVATION_LOCKED_TO_ORDER/)
      await db.query('delete from stock_reservations where session_id=$1', [key])
      await assert.rejects(reserve(a, key, [item(p, 1)]), /RESERVATION_LOCKED_TO_ORDER/)
    })
    await t.test('14-15: mismo checkout, doble request y dos pestañas no duplican', async () => {
      const p = await product(1); const key = session()
      const outcomes = await Promise.allSettled([reserve(a, key, [item(p, 1)]), reserve(b, key, [item(p, 1)])])
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 2)
      assert.equal(await count(p), 1)
      assert.equal(outcomes[0].value.rows[0].result.expires_at, outcomes[1].value.rows[0].result.expires_at)
    })
    await t.test('sesión autenticada ajena y RPC antiguas no pueden tomar una reserva', async () => {
      const owner = '10000000-0000-4000-8000-000000000001'
      const other = '10000000-0000-4000-8000-000000000002'
      await db.query('insert into auth.users(id) values($1),($2)', [owner, other])
      const p = await product(1); const key = session()
      await a.query("select set_config('request.jwt.claim.sub',$1,false)", [owner])
      await b.query("select set_config('request.jwt.claim.sub',$1,false)", [other])
      try {
        await reserve(a, key, [item(p, 1)])
        await assert.rejects(reserve(b, key, [item(p, 1)]), /INVALID_SESSION/)
        assert.equal(await count(p), 1)
      } finally {
        await a.query("reset request.jwt.claim.sub")
        await b.query("reset request.jwt.claim.sub")
      }
      const permissions = (await db.query(`
        select has_function_privilege('service_role', 'public.complete_cart_stock_reservation(text,bigint)', 'EXECUTE') as complete,
               has_function_privilege('service_role', 'public.validate_checkout_inventory_reservation_before_step_reservations(jsonb,text,bigint)', 'EXECUTE') as bypass
      `)).rows[0]
      assert.equal(permissions.complete, false)
      assert.equal(permissions.bypass, false)
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    // embedded-postgres.stop() espera 'exit'. No esperar 'close': en Windows
    // un subproceso de PostgreSQL puede conservar stdout abierto tras 'exit'.
    const child = server.process
    if (child && child.exitCode === null && child.signalCode === null) {
      await server.stop()
    } else {
      server.process = undefined
    }
  }
})
