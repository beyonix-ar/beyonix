import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const actor = '20000000-0000-4000-8000-000000000002'

test('dispatch: concurrent membership and handover cannot double include or refund', { timeout: 180000 }, async () => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-dispatch-pg')
  const clients = []
  const connect = async () => {
    const client = server.getPgClient('postgres', '127.0.0.1')
    await client.connect()
    clients.push(client)
    await client.query("set statement_timeout='10s'")
    await client.query("set request.jwt.claim.role='service_role'")
    return client
  }
  try {
    await server.initialise(); await server.start()
    const db = await connect()
    await db.query(read('./fixtures/dispatch-schema.sql'))
    await db.query(read('../../supabase/migrations/20261005100000_dispatch_operations.sql'))
    await db.query(read('../../supabase/migrations/20261005110000_dispatch_guards.sql'))
    await db.query('insert into profiles(id,rol) values ($1,$2)', [actor,'operador'])
    await db.query("insert into productos values (1,'SKU-A','BAR-A')")
    await db.query('insert into ordenes(id) values (1)')
    await db.query('insert into orden_items(id,orden_id,producto_id,cantidad) values (1,1,1,1)')
    await db.query('select begin_order_preparation($1,$2)', [1,actor])
    await db.query('select scan_order_preparation_item($1,$2,$3,$4,$5)', [1,1,'SKU-A',actor,'30000000-0000-4000-8000-000000000001'])
    const b1=(await db.query('select (create_dispatch_batch($1,$2)).id id', [actor,'40000000-0000-4000-8000-000000000001'])).rows[0].id
    const b2=(await db.query('select (create_dispatch_batch($1,$2)).id id', [actor,'40000000-0000-4000-8000-000000000002'])).rows[0].id
    const a=await connect(), b=await connect()
    const additions=await Promise.allSettled([
      a.query('select add_order_to_dispatch_batch($1,$2,$3)',[b1,1,actor]),
      b.query('select add_order_to_dispatch_batch($1,$2,$3)',[b2,1,actor]),
    ])
    assert.equal(additions.filter(r=>r.status==='fulfilled').length,1)
    const winningBatch=(await db.query('select batch_id from dispatch_batch_items where removed_at is null')).rows[0].batch_id
    await db.query('select close_dispatch_batch($1,$2)',[winningBatch,actor])
    const race=await Promise.allSettled([
      a.query('select hand_over_dispatch_batch($1,$2)',[winningBatch,actor]),
      b.query("insert into mercadopago_order_refunds(order_id,status,automation_mode) values (1,'processing','automatic')"),
    ])
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
    const handed=(await db.query('select andreani_handed_over_at from ordenes where id=1')).rows[0].andreani_handed_over_at !== null
    const refund=(await db.query("select count(*)::int n from mercadopago_order_refunds where order_id=1 and status='processing'")).rows[0].n > 0
    assert.notEqual(handed,refund)
    assert.ok((await db.query('select count(*)::int n from dispatch_batch_items where order_id=1 and removed_at is null')).rows[0].n===1)
  } finally {
    await Promise.allSettled(clients.map(client=>client.end()))
    await stopIsolatedPostgres(server,databaseDir)
  }
})
