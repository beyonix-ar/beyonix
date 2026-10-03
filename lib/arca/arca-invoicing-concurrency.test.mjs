import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Facturación ARCA con conexiones PostgreSQL REALES y simultáneas:
//   A. dos procesos facturan el mismo pedido -> sólo uno lo toma;
//   D. cron y reintento manual a la vez -> nunca dos 'processing';
//   dos workers sobre una cola -> jamás dos números pedidos para una venta.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('ARCA: claims concurrentes con dos backends PostgreSQL', { timeout: 180000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-arca-pg')
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
    await db.query(read('./fixtures/arca-invoicing-schema.sql'))
    const consumes = read('../../supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql')
      .match(/create or replace function public\.inventory_order_consumes_stock\([\s\S]*?\n\$function\$;/)?.[0]
    assert.ok(consumes)
    await db.query(consumes)
    await db.query(read('../../supabase/migrations/20260927100000_arca_automatic_invoicing.sql'))
    await db.query(read('../../supabase/migrations/20260927120000_arca_environment_isolation.sql'))
    const a = await connect(); const b = await connect()

    const paidOrder = async () => {
      const id = (await db.query("insert into ordenes (total) values (1000) returning id")).rows[0].id
      await db.query("update ordenes set estado='pagado', payment_status='approved', financial_status='payment_confirmed' where id=$1", [id])
      return Number(id)
    }
    const claim = (client, id, manual) => client.query(
      "select * from claim_arca_invoice($1, interval '10 minutes', $2)", [id, manual])
    const processingCount = async () => Number((await db.query(
      "select count(*)::int as n from ordenes where invoice_status='processing'")).rows[0].n)

    await t.test('A. dos procesos facturan el mismo pedido a la vez: sólo uno lo toma', async () => {
      for (let round = 0; round < 5; round += 1) {
        const id = await paidOrder()
        const outcomes = await Promise.allSettled([claim(a, id, false), claim(b, id, false)])
        const taken = outcomes.filter((r) => r.status === 'fulfilled' && r.value.rows.length === 1).length
        assert.equal(taken, 1)
        assert.equal(await processingCount(), 1)
        await db.query("update ordenes set invoice_status='authorized', invoice_cae='CAE-'||id, invoice_number=id, invoice_point=3, invoice_arca_environment='homologation', invoice_processing_started_at=null where id=$1", [id])
      }
    })

    await t.test('D. cron y reintento manual simultáneos: nunca dos pedidos facturando', async () => {
      const first = await paidOrder()
      const second = await paidOrder()
      const outcomes = await Promise.allSettled([claim(a, null, false), claim(b, second, true)])
      const rows = outcomes.flatMap((r) => (r.status === 'fulfilled' ? r.value.rows : []))
      assert.equal(rows.length, 1, 'uno solo avanza')
      const rejected = outcomes.filter((r) => r.status === 'rejected')
      assert.ok(rejected.every((r) => /INVOICE_PROCESSING_IN_PROGRESS|INVOICE_ALREADY_PROCESSING/.test(r.reason.message)))
      assert.equal(await processingCount(), 1)
      assert.ok([first, second].includes(Number(rows[0].id)))
    })

    await t.test('dos workers con número pedido: jamás el mismo comprobante en dos ventas', async () => {
      await db.query("update ordenes set invoice_status='error', invoice_processing_started_at=null, invoice_next_attempt_at=now() where invoice_status='processing'")
      const x = await paidOrder(); const y = await paidOrder()
      await db.query("update ordenes set invoice_status='processing', invoice_processing_started_at=now() where id in ($1,$2)", [x, y])
      const outcomes = await Promise.allSettled([
        a.query("select * from record_arca_invoice_request($1, 3, 11, 900, 1000, '20260927', 'homologation')", [x]),
        b.query("select * from record_arca_invoice_request($1, 3, 11, 900, 1000, '20260927', 'homologation')", [y]),
      ])
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1)
      assert.match(outcomes.find((r) => r.status === 'rejected').reason.message, /INVOICE_NUMBER_ALREADY_REQUESTED/)
    })

    await t.test('cutoff activo: dos runners concurrentes toman sólo una venta nueva', async () => {
      await db.query("update ordenes set invoice_status='error', invoice_processing_started_at=null where invoice_status='processing'")
      const historic = await paidOrder()
      await db.query(read('../../supabase/migrations/20261003120000_arca_auto_invoicing_activation.sql'))
      const manual = await paidOrder()
      await db.query("update ordenes set invoice_status='authorized', invoice_cae='CAE-MANUAL-PROD', invoice_number=1000, invoice_point=3, invoice_arca_environment='production' where id=$1", [manual])
      await db.query("insert into order_audit_events (order_id, actor_type, action, metadata) values ($1, 'system', 'arca_invoice_attempt_started', '{\"manual\":true}'::jsonb)", [manual])
      await db.query("select * from set_arca_auto_invoicing(true, '00000000-0000-4000-8000-000000000001')")
      const fresh = await paidOrder()
      const outcomes = await Promise.allSettled([claim(a, null, false), claim(b, null, false)])
      const taken = outcomes.flatMap((r) => r.status === 'fulfilled' ? r.value.rows : [])
      assert.equal(taken.length, 1)
      assert.equal(Number(taken[0].id), fresh)
      assert.equal((await db.query('select invoice_status from ordenes where id=$1', [historic])).rows[0].invoice_status, 'pending')
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
