import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Ventas externas con dos backends PostgreSQL reales: el perdedor de cada
// carrera espera un lock real y recién después decide con datos frescos.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const MIGRATIONS = [
  '20260801100000_inventory_sale_write_guards',
  '20260918100000_refresh_inventory_stock_fail_closed',
  '20260918150000_purchase_inventory_refresh_reproducibility',
  '20260921100000_external_sale_reversal',
  '20260923110000_external_sale_creation_and_write_guards',
  '20261027210000_external_sales_imports_and_lifecycle',
]
const ADMIN = '10000000-0000-4000-8000-000000000001'
const OTHER_ADMIN = '10000000-0000-4000-8000-000000000003'

const row = (n, overrides = {}) => ({
  source_row_number: n, sale_date: '2026-03-15', customer_name: `Cliente ${n}`, channel: 'direct',
  sku: 'AUR-1', product_name: 'Auricular Ñandú', quantity: 1, gross_amount: 15000, status: 'completed',
  ...overrides,
})

test('ventas externas: carreras reales con checkout, doble submit y edición', { timeout: 180000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-external-sales-pg')
  const clients = []
  const connect = async () => {
    const client = server.getPgClient('postgres', '127.0.0.1')
    await client.connect()
    clients.push(client)
    await client.query("set statement_timeout = '10s'")
    return client
  }
  try {
    await server.initialise(); await server.start()
    const db = await connect()
    await db.query(read('./fixtures/external-sales-schema.sql'))
    for (const name of MIGRATIONS) await db.query(read(`../../supabase/migrations/${name}.sql`))
    await db.query(`
      insert into auth.users values ('${ADMIN}'), ('${OTHER_ADMIN}');
      insert into profiles values ('${ADMIN}', 'admin', null), ('${OTHER_ADMIN}', 'super_admin', null);
      insert into productos (id, nombre, sku) values (1, 'Auricular Ñandú', 'AUR-1');
      insert into catalog_sku_registry values ('AUR-1', 1, null, null);
      insert into product_cost_entries (product_id, sku, purchase_date, received_quantity) values (1, 'AUR-1', '2026-01-01', 3);
      select refresh_inventory_stock(1);
    `)
    const a = await connect(); const b = await connect()
    const stock = async () => Number((await db.query('select stock from productos where id = 1')).rows[0].stock)
    let counter = 0
    const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}`
    const importBatch = (client, rows, mode, idempotencyKey = key('import'), actor = ADMIN) => client.query(
      'select import_external_sales_batch($1::jsonb, $2::jsonb, $3, $4) as r',
      [JSON.stringify({ source: 'paste', stock_mode: mode }), JSON.stringify(rows), actor, idempotencyKey],
    ).then((result) => result.rows[0].r)

    const race = async (first, second) => {
      await a.query('begin'); await b.query('begin')
      try {
        const winner = await first(a)
        const pid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid
        const pending = second(b).then((value) => ({ value }), (error) => ({ error }))
        let blocked = false
        for (let attempt = 0; attempt < 200; attempt++) {
          const state = await db.query('select cardinality(pg_blocking_pids($1)) > 0 as blocked', [pid])
          if (state.rows[0].blocked) { blocked = true; break }
          await delay(10)
        }
        assert.ok(blocked, 'la segunda conexión debe esperar un lock real')
        await a.query('commit')
        const loser = await pending
        await b.query(loser.error ? 'rollback' : 'commit')
        return { winner, ...loser }
      } finally {
        await a.query('rollback'); await b.query('rollback')
      }
    }

    await t.test('checkout reserva primero (mismo lock por producto): la venta nueva no roba la unidad', async () => {
      // Protocolo de reserve_cart_stock: lock 93000 por producto + fila en stock_reservations.
      const checkout = (client) => client.query(`
        select pg_advisory_xact_lock(93000, 1);
        insert into stock_reservations values ('web-session-1', 1, null, null, 2, now() + interval '10 minutes', null);
      `)
      const result = await race(checkout, (client) => importBatch(client, [row(2, { quantity: 2 })], 'consume'))
      assert.match(result.error?.message ?? '', /EXTERNAL_SALE_STOCK_UNAVAILABLE: AUR-1 tiene 1 unidades disponibles/)
      assert.equal(await stock(), 3)
      await db.query('delete from stock_reservations')
    })

    await t.test('venta nueva primero: el checkout que espera ve el stock ya descontado', async () => {
      const result = await race(
        (client) => importBatch(client, [row(2, { quantity: 2 })], 'consume'),
        (client) => client.query('select pg_advisory_xact_lock(93000, 1); select stock from productos where id = 1'),
      )
      assert.ifError(result.error)
      assert.equal(Number(result.value[1].rows[0].stock), 1)
      assert.equal(await stock(), 1)
    })

    await t.test('doble submit concurrente con la misma clave: una sola tanda y un solo descuento', async () => {
      const shared = key('double-submit')
      const result = await race(
        (client) => importBatch(client, [row(5, { customer_name: 'Doble' })], 'consume', shared),
        (client) => importBatch(client, [row(5, { customer_name: 'Doble' })], 'consume', shared),
      )
      assert.ifError(result.error)
      assert.equal(result.value.batch_id, result.winner.batch_id)
      assert.equal(result.value.replayed, true)
      assert.equal((await db.query("select count(*)::int n from external_sales where customer_name = 'Doble'")).rows[0].n, 1)
      assert.equal(await stock(), 0)
    })

    await t.test('misma tanda confirmada a la vez con claves distintas: la segunda espera y ve la primera', async () => {
      // SKU histórico sin catálogo: no hay lock por producto que serialice.
      const rows = [
        row(2, { sku: 'SOLO-EXCEL-1', product_name: 'Funda sólo del Excel', customer_name: 'Concurrente' }),
        row(3, { sku: 'SOLO-EXCEL-2', product_name: 'Cable sólo del Excel', customer_name: 'Concurrente' }),
      ]
      const result = await race(
        (client) => importBatch(client, rows, 'none', key('same-content-a')),
        (client) => importBatch(client, rows, 'none', key('same-content-b')),
      )
      assert.equal(result.winner.imported, 2)
      assert.match(result.error?.message ?? '', /EXTERNAL_SALE_POSSIBLE_DUPLICATE: la fila 2 parece repetida/,
        'la segunda importación no pasa como si la primera no existiera')
      assert.equal((await db.query("select count(*)::int n from external_sales where customer_name = 'Concurrente'")).rows[0].n, 2)
      assert.equal((await db.query("select count(*)::int n from external_sale_import_batches where rows_imported = 2 and stock_mode = 'none'")).rows[0].n, 1)

      // Con producto vinculado y contenido equivalente (SKU en minúsculas, espacios en el cliente).
      const linked = [row(4, { customer_name: 'Equivalente', sale_date: '2026-02-01' })]
      const equivalent = [row(7, { sku: ' aur-1 ', customer_name: '  equivalente ', sale_date: '2026-02-01' })]
      const second = await race(
        (client) => importBatch(client, linked, 'none', key('equivalent-a')),
        (client) => importBatch(client, equivalent, 'none', key('equivalent-b')),
      )
      assert.match(second.error?.message ?? '', /EXTERNAL_SALE_POSSIBLE_DUPLICATE: la fila 7 parece repetida/)
    })

    await t.test('dos ventas legítimamente iguales confirmadas con "Es una venta distinta": ambas existen', async () => {
      const rows = [row(2, { customer_name: 'Gemelas', sale_date: '2026-02-02', confirm_duplicate: true })]
      const result = await race(
        (client) => importBatch(client, rows, 'none', key('twins-a')),
        (client) => importBatch(client, rows, 'none', key('twins-b')),
      )
      assert.ifError(result.error)
      assert.notEqual(result.value.batch_id, result.winner.batch_id)
      assert.equal((await db.query("select count(*)::int n from external_sales where customer_name = 'Gemelas'")).rows[0].n, 2)
      // Sin confirmar, una tercera igual vuelve a advertir.
      await assert.rejects(importBatch(db, [row(2, { customer_name: 'Gemelas', sale_date: '2026-02-02' })], 'none'), /POSSIBLE_DUPLICATE/)
    })

    await t.test('dos administradores editan la misma venta: el segundo recibe conflicto de versión', async () => {
      const sale = (await db.query("select id, version from external_sales where customer_name = 'Doble'")).rows[0]
      const edit = (client, actor, notes) => client.query(
        'select (update_external_sale($1, $2, $3::jsonb, $4)).version as version',
        [sale.id, sale.version, JSON.stringify({ notes }), actor],
      )
      const result = await race((client) => edit(client, ADMIN, 'Primera edición'), (client) => edit(client, OTHER_ADMIN, 'Segunda edición'))
      assert.match(result.error?.message ?? '', /EXTERNAL_SALE_VERSION_CONFLICT/)
      assert.equal((await db.query('select notes from external_sales where id = $1', [sale.id])).rows[0].notes, 'Primera edición')
    })

    await t.test('deshacer tanda vs edición: la edición espera y no modifica una venta ya anulada', async () => {
      const batch = (await db.query("select import_batch_id from external_sales where customer_name = 'Doble'")).rows[0].import_batch_id
      const sale = (await db.query("select id, version from external_sales where customer_name = 'Doble'")).rows[0]
      // La venta ya fue editada: deshacer está bloqueado. Se usa una tanda limpia.
      await assert.rejects(
        db.query("select revert_external_sale_import_batch($1, 1, 'Tanda cargada por error', $2)", [batch, ADMIN]),
        /EXTERNAL_SALE_BATCH_HAS_MODIFIED_SALES/,
      )
      assert.ok(sale.version > 1)
      const clean = await importBatch(db, [row(9, { customer_name: 'Limpia' })], 'none')
      const target = (await db.query("select id, version from external_sales where customer_name = 'Limpia'")).rows[0]
      const result = await race(
        (client) => client.query("select revert_external_sale_import_batch($1, 1, 'Tanda cargada por error', $2) as r", [clean.batch_id, ADMIN]),
        (client) => client.query('select update_external_sale($1, $2, $3::jsonb, $4)', [target.id, target.version, JSON.stringify({ notes: 'Tarde' }), OTHER_ADMIN]),
      )
      assert.match(result.error?.message ?? '', /EXTERNAL_SALE_ALREADY_REVERSED/)
      assert.equal((await db.query('select status from external_sales where id = $1', [target.id])).rows[0].status, 'reversed')
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
