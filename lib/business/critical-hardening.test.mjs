import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import EmbeddedPostgres from 'embedded-postgres'
import { AuthClient } from '@supabase/supabase-js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const migration = (name) => read(`../../supabase/migrations/${name}.sql`)
const functionBody = (name, file) => {
  const sql = migration(file)
  const start = sql.toLowerCase().indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0, name)
  const body = sql.slice(start)
  const delimiter = body.match(/\bas\s+(\$\w*\$)/i)[1]
  const end = body.indexOf(`${delimiter};`, body.indexOf(delimiter) + delimiter.length)
  return body.slice(0, end + delimiter.length + 1)
}
const actor = '10000000-0000-4000-8000-000000000001'
const payload = { sale_date: '2026-01-01', product_id: 1, product_name: 'Prueba', quantity: 2,
  unit_price: 50, unit_cost: 10, gross_amount: 100, fee_type: 'amount', fee_value: 0,
  fee_amount: 0, shipping_amount: 0, other_expense_amount: 0, net_amount: 80 }

test('Auditoría 7: permisos y carreras con backends PostgreSQL independientes', { timeout: 120000 }, async (t) => {
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  // Keep the generated directory: no recursive deletion of computed paths.
  const databaseDir = mkdtempSync(join(tmpdir(), 'beyonix-hardening-pg-'))
  const server = new EmbeddedPostgres({ databaseDir, port, user: 'postgres', password: 'isolated-test',
    persistent: true, postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} })
  const clients = []
  const connect = async () => {
    const client = server.getPgClient('postgres', '127.0.0.1')
    await client.connect(); clients.push(client)
    await client.query("set statement_timeout = '10s'")
    return client
  }
  try {
    await server.initialise(); await server.start()
    const db = await connect()
    await db.query(read('../orders/fixtures/admin-cancel-order-schema.sql'))
    await db.query(read('./fixtures/critical-hardening-schema.sql'))
    for (const [name, file] of [
      ['reverse_customer_credit_for_order', '20260911150000_reverse_customer_credit_resets_order_due'],
      ['admin_cancel_order', '20260916100000_block_cancellation_during_andreani_creation'],
      ['reverse_external_sale', '20260921100000_external_sale_reversal'],
      ['refresh_inventory_stock', '20260918100000_refresh_inventory_stock_fail_closed'],
      ['refresh_inventory_from_row', '20260918150000_purchase_inventory_refresh_reproducibility'],
      ['lock_inventory_sale_targets', '20260801100000_inventory_sale_write_guards'],
      ['reject_negative_inventory_sale', '20260801100000_inventory_sale_write_guards'],
    ]) await db.query(functionBody(name, file))
    await db.query(`
      create trigger lock_inventory_external_sale before insert or update or delete on external_sales
        for each row execute function lock_inventory_sale_targets();
      create trigger refresh_inventory_after_external_sale after insert or update or delete on external_sales
        for each row execute function refresh_inventory_from_row();
      create trigger zz_reject_negative_external_sale after insert or update or delete on external_sales
        for each row execute function reject_negative_inventory_sale();
      insert into auth.users(id) values ('${actor}');
      insert into profiles(id, rol) values ('${actor}', 'admin');
      insert into productos(id) values (1);
    `)
    for (const file of ['20260923100000_secure_legacy_arca_credit_note',
      '20260923110000_external_sale_creation_and_write_guards', '20260923120000_atomic_manual_transfer_review']) {
      await db.query(migration(file))
    }
    const a = await connect(), b = await connect()
    for (const client of [a, b]) await client.query("set role service_role; set request.jwt.claim.role = 'service_role'")
    const create = (client, key, value = payload) => client.query(
      'select * from create_external_sale_idempotent($1, $2, $3)', [value, actor, key])
    const reverse = (client, id) => client.query('select * from reverse_external_sale($1, $2, $3, $4)',
      [id, 'Reversión controlada de prueba', actor, `reverse:${id}`])
    const edit = (client, id) => client.query("update external_sales set quantity=3, gross_amount=150 where id=$1 and status='completed' returning *", [id])
    const confirm = (client, id) => client.query('select * from review_manual_transfer_payment($1,$2,$3,$4,$5)',
      [id, actor, 'en_revision', 'confirmado', 'Revisión manual'])
    const cancel = (client, id, action = 'reject') => client.query('select * from admin_cancel_order($1,$2,$3,$4,$5,$6)',
      [id, actor, 'admin', action, 'solicitud_cliente', 'Cancelación de prueba'])
    const order = async (id) => db.query(`insert into ordenes(id,usuario_id,estado,payment_status,financial_status,
      credit_balance_used,external_amount_due) values($1,$2,'pendiente','en_revision','payment_submitted',30,70)`, [id, actor])
    // Confirm the loser really waits on another backend's lock before committing.
    const race = async (first, second) => {
      await a.query('begin'); await b.query('begin')
      try {
        const winner = await first(a)
        const pid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid
        const pending = second(b).then(value => ({ value }), error => ({ error }))
        let blocked = false
        for (let attempt = 0; attempt < 100; attempt++) {
          const state = await db.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [pid])
          if (state.rows[0].blocked) { blocked = true; break }
          await delay(10)
        }
        assert.ok(blocked, 'la segunda conexión debe esperar un lock real')
        await a.query('commit')
        const loser = await pending
        await b.query(loser.error ? 'rollback' : 'commit')
        return { winner, ...loser }
      } finally { await a.query('rollback'); await b.query('rollback') }
    }

    await t.test('anon/authenticated no ejecutan ARCA; service_role conserva flujo legítimo', async () => {
      await order(1)
      for (const role of ['anon', 'authenticated']) {
        await db.query(`set role ${role}; set request.jwt.claim.role = '${role}'`)
        await assert.rejects(db.query('select * from begin_arca_credit_note_processing(1)'), /permission denied/)
        await db.query('reset role')
      }
      await a.query('select * from begin_arca_credit_note_processing(1)')
      assert.equal((await db.query('select credit_note_status from ordenes where id=1')).rows[0].credit_note_status, 'processing')
      await db.query("set request.jwt.claim.role = ''")
      await assert.rejects(db.query('select * from begin_arca_credit_note_processing(1)'), /FORBIDDEN/)
    })
    await t.test('retry y alta concurrente: misma fila, un INSERT y una baja de stock', async () => {
      const result = await race(c => create(c, 'creation-retry-001'), c => create(c, 'creation-retry-001'))
      assert.ifError(result.error)
      assert.equal(result.winner.rows[0].id, result.value.rows[0].id)
      assert.equal((await create(a, 'creation-retry-001')).rows[0].id, result.winner.rows[0].id)
      assert.equal((await db.query('select count(*)::int as n from test_sale_insert_events')).rows[0].n, 1)
      assert.equal((await db.query('select stock from productos where id=1')).rows[0].stock, 8)
      await assert.rejects(create(a, 'creation-retry-001', { ...payload, quantity: 3 }), /IDEMPOTENCY_PAYLOAD_MISMATCH/)
    })
    await t.test('authenticated no puede INSERT/UPDATE/DELETE directo; SELECT sigue permitido', async () => {
      await db.query('set role authenticated')
      for (const sql of ['update external_sales set quantity=5', 'delete from external_sales',
        "insert into external_sales(sale_date,product_name,quantity,unit_price,unit_cost,gross_amount) values(current_date,'bypass',1,1,0,1)"]) {
        await assert.rejects(db.query(sql), /permission denied/)
      }
      assert.equal((await db.query('select count(*)::int n from external_sales')).rows[0].n, 1)
      await db.query('reset role')
    })
    await t.test('las RPC nuevas rechazan authenticated y actores sin rol administrativo', async () => {
      await db.query('set role authenticated')
      await assert.rejects(create(db, 'forbidden-create'), /permission denied/)
      await assert.rejects(confirm(db, 1), /permission denied/)
      await db.query('reset role')
      await assert.rejects(a.query('select * from create_external_sale_idempotent($1,$2,$3)',
        [payload, '10000000-0000-4000-8000-000000000099', 'forbidden-actor']), /FORBIDDEN/)
      await assert.rejects(a.query('select * from review_manual_transfer_payment($1,$2,$3,$4,$5)',
        [1, '10000000-0000-4000-8000-000000000099', 'en_revision', 'confirmado', 'test']), /FORBIDDEN/)
    })
    await t.test('stock insuficiente aborta alta completa; conserva saldo e historial de INSERT', async () => {
      await assert.rejects(create(a, 'insufficient-stock', { ...payload, quantity: 99 }), /NEGATIVE_STOCK|STOCK_INSUFICIENTE/)
      assert.equal((await db.query('select stock from productos where id=1')).rows[0].stock, 8)
      assert.equal((await db.query('select count(*)::int n from test_sale_insert_events')).rows[0].n, 1)
    })
    await t.test('reverse gana: PATCH bloqueado reevalúa completed; trigger protege UPDATE sin filtro', async () => {
      const id = (await create(a, 'race-reverse-first')).rows[0].id
      const result = await race(c => reverse(c, id), c => edit(c, id))
      assert.ifError(result.error); assert.equal(result.value.rowCount, 0)
      await assert.rejects(a.query('update external_sales set quantity=9 where id=$1', [id]), /EXTERNAL_SALE_ALREADY_REVERSED/)
      assert.equal((await db.query('select quantity from external_sales where id=$1', [id])).rows[0].quantity, 2)
    })
    await t.test('edit gana: reverse espera y usa el importe editado; retry no restaura dos veces', async () => {
      const id = (await create(a, 'race-edit-first')).rows[0].id
      const result = await race(c => edit(c, id), c => reverse(c, id))
      assert.ifError(result.error)
      assert.equal(Number(result.value.rows[0].reversal_amount), 150)
      await reverse(a, id)
      assert.equal((await db.query('select stock from productos where id=1')).rows[0].stock, 8)
    })
    await t.test('desvincular catálogo preserva una reversión; no permite editar importes ni volver a vincular', async () => {
      const old = (await db.query("select * from external_sales where creation_idempotency_key='race-edit-first'")).rows[0]
      await assert.rejects(a.query('update external_sales set product_id=null, gross_amount=0 where id=$1', [old.id]), /EXTERNAL_SALE_ALREADY_REVERSED/)
      const detached = (await a.query('update external_sales set product_id=null, variant_id=null where id=$1 returning *', [old.id])).rows[0]
      assert.deepEqual(detached, { ...old, product_id: null, variant_id: null })
      await assert.rejects(a.query('update external_sales set product_id=1 where id=$1', [old.id]), /EXTERNAL_SALE_ALREADY_REVERSED/)
      assert.equal((await db.query('select stock from productos where id=1')).rows[0].stock, 8)
    })
    await t.test('cancel gana: confirmación esperando falla y saldo se reintegra una vez', async () => {
      await order(2)
      const result = await race(c => cancel(c, 2), c => confirm(c, 2))
      assert.match(result.error?.message ?? '', /TRANSFER_CANCELLATION_CONFLICT/)
      const row = (await db.query('select * from ordenes where id=2')).rows[0]
      assert.equal(row.estado, 'cancelado'); assert.equal(row.financial_status, 'cancelled')
      assert.equal(Number(row.credit_balance_used), 0)
      assert.equal((await db.query('select count(*)::int n from customer_credit_movements where order_id=2')).rows[0].n, 1)
      await assert.rejects(confirm(a, 2), /TRANSFER_CANCELLATION_CONFLICT/)
    })
    await t.test('confirmación gana: rechazo ya no es válido; cancelación pagada usa refund_pending', async () => {
      await order(3)
      const result = await race(c => confirm(c, 3), c => cancel(c, 3))
      assert.match(result.error?.message ?? '', /ORDER_ALREADY_PAID_USE_CANCEL/)
      assert.equal((await db.query('select estado from ordenes where id=3')).rows[0].estado, 'pagado')
      await confirm(a, 3)
      assert.equal((await db.query("select count(*)::int n from order_audit_events where order_id=3 and action='payment_confirmed'")).rows[0].n, 1)
      await cancel(a, 3, 'cancel')
      const row = (await db.query('select * from ordenes where id=3')).rows[0]
      assert.equal(row.estado, 'cancelado'); assert.equal(row.financial_status, 'refund_pending')
      await assert.rejects(confirm(a, 3), /TRANSFER_CANCELLATION_CONFLICT/)
    })
    await t.test('cancelación de pago confirmado espera al confirmador en el mismo lock', async () => {
      await order(4)
      const result = await race(c => confirm(c, 4), c => cancel(c, 4, 'cancel'))
      assert.ifError(result.error)
      assert.equal(result.value.rows[0].financial_status, 'refund_pending')
    })
    await t.test('confirmación valida estado financiero, comprobante y CAS dentro de SQL', async () => {
      await order(5)
      await db.query("update ordenes set financial_status='refund_pending' where id=5")
      await assert.rejects(confirm(a, 5), /TRANSFER_CANCELLATION_CONFLICT/)
      await db.query("update ordenes set financial_status='payment_submitted', payment_proof_url=null where id=5")
      await assert.rejects(confirm(a, 5), /TRANSFER_INVALID_TRANSITION/)
      await db.query("update ordenes set payment_status='rechazado', payment_proof_url='proof' where id=5")
      await assert.rejects(confirm(a, 5), /TRANSFER_PAYMENT_CONFLICT/)
      assert.equal((await db.query('select count(*)::int n from order_audit_events where order_id=5')).rows[0].n, 0)
    })
    await t.test('rutas reales: POST repetido conserva identidad/stock; PATCH reversed y transferencia cancelada dan 409', async () => {
      const oldEnv = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://hardening.invalid'
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'isolated-key'
      const claims = mock.method(AuthClient.prototype, 'getClaims', async () => ({ data: { claims: { sub: actor } }, error: null }))
      const fetchMock = mock.method(globalThis, 'fetch', async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/profiles')) return Response.json({ id: actor, rol: 'admin' })
        if (url.pathname.endsWith('/productos')) return Response.json({ id: 1 })
        if (url.pathname.endsWith('/producto_variantes')) return Response.json([])
        const body = init?.body ? JSON.parse(init.body) : null
        if (url.pathname.endsWith('/rpc/create_external_sale_idempotent')) {
          return Response.json((await create(a, body.p_idempotency_key, body.p_payload)).rows[0])
        }
        if (url.pathname.endsWith('/external_sales') && init.method === 'PATCH') {
          assert.equal(url.searchParams.get('status'), 'eq.completed')
          const result = await a.query("update external_sales set quantity=$1 where id=$2 and status='completed' returning *", [body.quantity, url.searchParams.get('id').slice(3)])
          return Response.json(result.rows)
        }
        if (url.pathname.endsWith('/ordenes')) return Response.json((await db.query('select * from ordenes where id=2')).rows[0])
        if (url.pathname.endsWith('/rpc/review_manual_transfer_payment')) {
          try { return Response.json((await confirm(a, body.p_order_id)).rows[0]) }
          catch (error) { return Response.json({ message: error.message, code: 'P0001' }, { status: 400 }) }
        }
        throw new Error(`Unexpected request ${url.pathname}`)
      })
      try {
        const sales = await import('../../app/api/admin/sales-ledger/route.ts')
        const transfer = await import('../../app/api/admin/pedidos/[id]/payment-status/route.ts')
        const body = { channel: 'external', saleDate: '2026-01-01', productId: 1, productName: 'Prueba', quantity: 2, unitPrice: 50, unitCost: 10 }
        const request = (method, data, key = 'http-logical-attempt') => new Request('http://localhost/test', {
          method, headers: { Authorization: 'Bearer test', 'Idempotency-Key': key }, body: JSON.stringify(data) })
        const first = await sales.POST(request('POST', body)), second = await sales.POST(request('POST', body))
        assert.equal(first.status, 201); assert.equal(second.status, 201)
        const sale = (await first.json()).item
        assert.deepEqual(sale, (await second.json()).item)
        assert.equal((await db.query('select stock from productos where id=1')).rows[0].stock, 6)
        await reverse(a, sale.id)
        assert.equal((await sales.PATCH(request('PATCH', { ...body, id: sale.id }))).status, 409)
        assert.equal((await transfer.PATCH(request('PATCH', { payment_status: 'confirmado' }), { params: Promise.resolve({ id: '2' }) })).status, 409)
      } finally {
        claims.mock.restore(); fetchMock.mock.restore()
        for (const [key, value] of [['NEXT_PUBLIC_SUPABASE_URL', oldEnv.url], ['SUPABASE_SERVICE_ROLE_KEY', oldEnv.key]]) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value
        }
      }
    })
  } finally {
    await Promise.allSettled(clients.map(client => client.end()))
    await server.stop()
  }
})
