import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Notas de Crédito C con conexiones PostgreSQL REALES y simultáneas.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('NC ARCA: dos backends PostgreSQL a la vez', { timeout: 180000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-nc-pg')
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
    await db.query(read('./fixtures/arca-credit-note-schema.sql'))
    await db.query(read('../../supabase/migrations/20260927110000_arca_credit_note_hardening.sql'))
    await db.query(read('../../supabase/migrations/20260927120000_arca_environment_isolation.sql'))
    await db.query(`insert into ordenes (id, invoice_status, invoice_point, invoice_number, invoice_cae, invoice_arca_environment)
                    values (1, 'authorized', 3, 57, 'CAE-F57', 'homologation'), (2, 'authorized', 3, 58, 'CAE-F58', 'homologation')`)
    const a = await connect(); const b = await connect()
    const reserve = async (orderId, total) => (await db.query(
      `insert into order_credit_notes (order_id, total_amount, items_amount, invoice_point, invoice_number)
       values ($1, $2, $2, 3, 57) returning id`, [orderId, total])).rows[0].id

    await t.test('dos clicks/procesos sobre la misma NC: sólo uno toma el lease', async () => {
      for (let round = 0; round < 5; round += 1) {
        const id = await reserve(1, 300)
        const outcomes = await Promise.allSettled([
          a.query('select * from claim_credit_note_arca($1)', [id]),
          b.query('select * from claim_credit_note_arca($1)', [id]),
        ])
        assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1)
        assert.match(outcomes.find((r) => r.status === 'rejected').reason.message, /CREDIT_NOTE_ALREADY_PROCESSING/)
        await db.query("update order_credit_notes set status='error', arca_claimed_until=null where id=$1", [id])
      }
    })

    await t.test('dos NC de pedidos distintos a la vez: nunca dos en ARCA ni el mismo número', async () => {
      const outcomes = await Promise.allSettled([
        a.query(`insert into order_credit_notes (order_id, total_amount, items_amount, invoice_point, invoice_number)
                 values (1, 300, 300, 3, 57)`),
        b.query(`insert into order_credit_notes (order_id, total_amount, items_amount, invoice_point, invoice_number)
                 values (2, 200, 200, 3, 58)`),
      ])
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1, 'una sola NC processing en la tienda')
      const id = (await db.query("select id from order_credit_notes where status='processing'")).rows[0].id
      await db.query('select * from claim_credit_note_arca($1)', [id])
      const requests = await Promise.allSettled([
        a.query("select * from record_credit_note_request($1, 3, 9, (select total_amount from order_credit_notes where id=$1), '20260927', 'homologation')", [id]),
        b.query("select * from record_credit_note_request($1, 3, 9, (select total_amount from order_credit_notes where id=$1), '20260927', 'homologation')", [id]),
      ])
      assert.equal(requests.filter((r) => r.status === 'fulfilled').length, 2, 'mismo número para la misma NC: idempotente')
      const row = (await db.query('select voucher_number from order_credit_notes where id=$1', [id])).rows[0]
      assert.equal(Number(row.voucher_number), 9)
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
