import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'

// No connection URL is accepted: this runner always creates its own local cluster.
const directory = fileURLToPath(new URL('.', import.meta.url))
const metadata = JSON.parse(readFileSync(join(directory, 'production-schema-2026-09-21.json'), 'utf8'))
const snapshot = readFileSync(join(directory, metadata.schemaFile), 'utf8')
assert.equal(createHash('sha256').update(snapshot).digest('hex'), metadata.sha256)
const bin = process.env.BEYONIX_PG_BIN
assert.ok(bin, 'Set BEYONIX_PG_BIN to the PostgreSQL 17 bin directory')
const executable = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''))
const run = (name, args) => {
  const result = spawnSync(executable(name), args, { encoding: 'utf8', windowsHide: true, timeout: 120000,
    ...(name === 'pg_ctl' ? { stdio: 'ignore' } : {}) })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`)
  return result.stdout
}
assert.match(run('postgres', ['--version']), /PostgreSQL\) 17\./)
const socket = createServer()
await new Promise(r => socket.listen(0, '127.0.0.1', r))
const port = socket.address().port
await new Promise(r => socket.close(r))
const cluster = mkdtempSync(join(tmpdir(), 'beyonix-baseline-'))
const dataDir = join(cluster, 'data')
const clients = []
let started = false
const quote = value => '"' + value.replaceAll('"', '""') + '"'
const literal = value => "'" + value.replaceAll("'", "''") + "'"
const connect = async () => {
  const client = new pg.Client({ host: '127.0.0.1', port, user: 'baseline_owner', database: 'postgres' })
  await client.connect()
  clients.push(client)
  await client.query("set statement_timeout = '15s'")
  return client
}
const checks = []
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`) }
try {
  run('initdb', ['-D', dataDir, '-U', 'baseline_owner', '-A', 'trust', '--encoding=UTF8', '--locale=C'])
  run('pg_ctl', ['-D', dataDir, '-l', join(cluster, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c timezone=UTC`, '-w', 'start'])
  started = true
  const db = await connect()
  await db.query('drop schema public') // Only the empty schema in the cluster created above.
  for (const role of metadata.roles) {
    const options = [['rolsuper', 'SUPERUSER'], ['rolinherit', 'INHERIT'], ['rolcreaterole', 'CREATEROLE'],
      ['rolcreatedb', 'CREATEDB'], ['rolcanlogin', 'LOGIN'], ['rolreplication', 'REPLICATION'], ['rolbypassrls', 'BYPASSRLS']]
    await db.query(`create role ${quote(role.rolname)} ${options.map(([key, sql]) => (role[key] ? '' : 'NO') + sql).join(' ')}`)
  }
  for (const membership of metadata.memberships) {
    await db.query(`grant ${quote(membership.role)} to ${quote(membership.member)} with admin ${membership.admin_option}, inherit ${membership.inherit_option}, set ${membership.set_option}`)
  }
  // pg_dump --schema excludes extension definitions. Install the recorded standard
  // extensions after schemas exist, before defaults/types need their functions.
  const sql = snapshot.replace(/^\\(?:un)?restrict .*\r?\n/gm, '')
  const split = sql.indexOf('\nCREATE TYPE ')
  assert.ok(split > 0)
  await db.query(sql.slice(0, split))
  // Reproduce initdb's default PUBLIC usage, assumed by pg_dump for public.
  await db.query('grant usage on schema public to public')
  for (const extension of metadata.extensions.filter(e => e.nspname === 'extensions')) {
    await db.query(`create extension ${quote(extension.extname)} with schema ${quote(extension.nspname)} version ${literal(extension.extversion)}`)
  }
  await db.query(sql.slice(split))
  await db.query("set search_path = public; set check_function_bodies = true; set row_security=on; set statement_timeout='15s'")
  await check('snapshot restored with zero application rows', async () => {
    const tables = (await db.query("select schemaname,tablename from pg_tables where schemaname in ('public','auth','storage')")).rows
    for (const table of tables) assert.equal((await db.query(`select count(*)::int n from ${quote(table.schemaname)}.${quote(table.tablename)}`)).rows[0].n, 0)
    assert.equal(tables.length, 91)
  })
  const localDump = join(cluster, 'restored-schema.sql')
  run('pg_dump', ['-h', '127.0.0.1', '-p', String(port), '-U', 'baseline_owner', '-d', 'postgres',
    '--schema-only', '--quote-all-identifiers', ...metadata.schemas.map(s => '--schema=' + s), '--file=' + localDump])
  const normalizeDump = value => value.replace(/\r\n/g, '\n')
    .replace(/^\\(?:un)?restrict .*\n/gm, '').replace(/^-- Dumped (?:from|by).*\n/gm, '')
    .replace(/^(CREATE POLICY .*? TO )((?:"[^"]+"(?:, )?)+)/gm,
      (_, prefix, roles) => prefix + roles.split(', ').sort().join(', '))
    .replace(/(?:^ALTER DEFAULT PRIVILEGES[^\n]*\n)+/gm,
      block => block.trimEnd().split('\n').sort().join('\n') + '\n')
    // 17.11 flattens the first nested AND in this 17.6 CHECK expression.
    // Only remove these two redundant parentheses; retain every comparison.
    .replace(/^.*CONSTRAINT "customer_gift_cards_names_check".*$/gm,
      line => line.replace('CHECK ((((', 'CHECK (((').replace('<= 120)) AND', '<= 120) AND'))
  await check('restored schema equals source pg_dump', async () => {
    const actual = normalizeDump(readFileSync(localDump, 'utf8'))
    const expected = normalizeDump(snapshot)
    writeFileSync(join(cluster, 'actual.sql'), actual)
    writeFileSync(join(cluster, 'expected.sql'), expected)
    assert.ok(actual === expected, `Schema differs; inspect actual.sql and expected.sql in ${cluster}`)
  })
  for (const name of metadata.pendingMigrations) {
    await check(`migration ${name}`, async () => {
      await db.query(readFileSync(resolve(directory, '../migrations', name), 'utf8'))
    })
  }
  await check('final RPC permissions, RLS, constraint and unique index', async () => {
    for (const signature of ['begin_arca_credit_note_processing(bigint)',
      'create_external_sale_idempotent(jsonb,uuid,text)', 'review_manual_transfer_payment(bigint,uuid,text,text,text)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') allowed', [role, 'public.' + signature])).rows[0].allowed, role === 'service_role')
      }
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        assert.equal((await db.query("select has_table_privilege($1,'public.external_sales',$2) allowed", [role, privilege])).rows[0].allowed, role === 'service_role')
      }
    }
    assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.external_sales'::regclass")).rows[0].relrowsecurity, true)
    const index = (await db.query("select indisunique,indisvalid,pg_get_expr(indpred,indrelid) predicate from pg_index where indexrelid='public.external_sales_creation_key_uidx'::regclass")).rows[0]
    assert.equal(index.indisunique, true); assert.equal(index.indisvalid, true)
    assert.match(index.predicate, /creation_idempotency_key IS NOT NULL/)
    assert.equal((await db.query("select convalidated from pg_constraint where conrelid='external_sales'::regclass and conname='external_sales_creation_request_check'")).rows[0].convalidated, true)
  })
  const actor = '10000000-0000-4000-8000-000000000001'
  const customer = '10000000-0000-4000-8000-000000000002'
  await db.query("set request.jwt.claim.role='service_role'")
  for (const [id, email] of [[actor, 'baseline-admin@example.invalid'], [customer, 'baseline-customer@example.invalid']]) {
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [id, email, { nombre: 'Prueba técnica' }])
  }
  await db.query("update profiles set rol='admin' where id=$1", [actor])
  // Complete synthetic catalog: use real commercial guards, never disable them.
  await db.query('begin')
  const category = (await db.query("insert into categorias(nombre,slug) values('Prueba baseline','prueba-baseline') returning id")).rows[0].id
  const product = (await db.query(`insert into productos(nombre,slug,precio,activo,categoria_id,descripcion,
    peso_empaquetado_kg,alto_paquete_cm,ancho_paquete_cm,largo_paquete_cm)
    values('Prueba baseline','prueba-baseline',100,false,$1,'Producto sintético local',1,10,10,10) returning id`, [category])).rows[0].id
  const variant = (await db.query(`insert into producto_variantes(producto_id,nombre,color_hex,sku,imagenes,activo)
    values($1,'Variante de prueba','#112233','BASELINE-001','["https://example.invalid/local.png"]',false) returning id`, [product])).rows[0].id
  await db.query("insert into producto_especificaciones(producto_id,icono,texto) values($1,'Box','Especificación de prueba')", [product])
  await db.query('insert into product_cost_entries(product_id,variant_id,quantity,received_quantity,unit_cost,created_by) values($1,$2,20,20,10,$3)', [product, variant, actor])
  await db.query('update productos set activo=true where id=$1', [product])
  await db.query('update producto_variantes set activo=true where id=$1', [variant])
  await db.query('commit')
  const stock = async () => (await db.query('select stock from productos where id=$1', [product])).rows[0].stock
  assert.equal(await stock(), 20)
  const a = await connect(), b = await connect()
  for (const client of [a, b]) await client.query("set role service_role; set request.jwt.claim.role='service_role'")
  const seedDate = (await db.query('select current_date::text value')).rows[0].value
  const payload = { sale_date: seedDate, product_id: Number(product), variant_id: Number(variant), product_name: 'Prueba baseline', quantity: 2,
    unit_price: 50, unit_cost: 10, gross_amount: 100, fee_type: 'amount', fee_value: 0,
    fee_amount: 0, shipping_amount: 0, other_expense_amount: 0, net_amount: 80 }
  const create = (client, key, value = payload) => client.query('select * from create_external_sale_idempotent($1,$2,$3)', [value, actor, key])
  const reverse = (client, id) => client.query('select * from reverse_external_sale($1,$2,$3,$4)', [id, 'Reversión de prueba local', actor, 'reverse:' + id])
  const edit = (client, id) => client.query("update external_sales set quantity=3,gross_amount=150 where id=$1 and status='completed' returning *", [id])
  const review = (client, id, status = 'confirmado') => client.query('select * from review_manual_transfer_payment($1,$2,$3,$4,$5)', [id, actor, 'en_revision', status, 'Revisión de prueba local'])
  const cancel = (client, id, action = 'reject') => client.query('select * from admin_cancel_order($1,$2,$3,$4,$5,$6)', [id, actor, 'admin', action, 'solicitud_cliente', 'Cancelación de prueba local'])
  const order = async () => {
    const id = (await db.query(`insert into ordenes(usuario_id,total,original_total,estado,payment_status,payment_method_id,
      financial_status,credit_balance_used,external_amount_due,payment_proof_url)
      values($1,100,100,'pendiente','en_revision','transferencia','payment_submitted',30,70,'local-proof') returning id`, [customer])).rows[0].id
    await db.query('insert into orden_items(orden_id,producto_id,variante_id,cantidad,precio) values($1,$2,$3,1,100)', [id, product, variant])
    await db.query(`insert into customer_credit_movements(user_id,movement_type,amount,description,source_type,source_key,created_by)
      values($1,'credit',30,'Crédito sintético local','admin_adjustment',$2,$3)`, [customer, 'baseline-credit:' + id, actor])
    const movement = (await db.query(`insert into customer_credit_movements(user_id,movement_type,amount,description,source_type,source_key,order_id,created_by)
      values($1,'debit',30,'Aplicación de saldo local','order',$2,$3,$4) returning id`, [customer, 'baseline-debit:' + id, id, actor])).rows[0].id
    await db.query('update ordenes set credit_balance_movement_id=$1 where id=$2', [movement, id])
    return id
  }
  const race = async (first, second) => {
    await a.query('begin'); await b.query('begin')
    let pending
    try {
      const winner = await first(a)
      const pid = (await b.query('select pg_backend_pid() pid')).rows[0].pid
      pending = second(b).then(value => ({ value }), error => ({ error }))
      let blocked = false
      for (let attempt = 0; attempt < 150; attempt++) {
        if ((await db.query('select cardinality(pg_blocking_pids($1)) > 0 blocked', [pid])).rows[0].blocked) { blocked = true; break }
        await delay(10)
      }
      assert.ok(blocked, 'second backend must wait on a real lock')
      await a.query('commit')
      const loser = await pending
      await b.query(loser.error ? 'rollback' : 'commit')
      return { winner, ...loser }
    } finally { await a.query('rollback'); if (pending) await pending; await b.query('rollback') }
  }
  await check('ARCA denies browser roles and accepts service_role', async () => {
    const id = await order()
    for (const role of ['anon', 'authenticated']) {
      await db.query(`set role ${role}`)
      await assert.rejects(db.query('select * from begin_arca_credit_note_processing($1)', [id]), /permission denied/)
      await db.query('reset role')
    }
    await a.query('select * from begin_arca_credit_note_processing($1)', [id])
    assert.equal((await db.query('select credit_note_status from ordenes where id=$1', [id])).rows[0].credit_note_status, 'processing')
  })
  await check('external creation concurrent retry has one sale and one stock deduction', async () => {
    const result = await race(c => create(c, 'baseline-retry-001'), c => create(c, 'baseline-retry-001'))
    assert.ifError(result.error)
    assert.equal(result.winner.rows[0].id, result.value.rows[0].id)
    assert.equal((await create(a, 'baseline-retry-001')).rows[0].id, result.value.rows[0].id)
    assert.equal((await db.query("select count(*)::int n from external_sales where creation_idempotency_key='baseline-retry-001'")).rows[0].n, 1)
    assert.equal(await stock(), 18)
    await assert.rejects(create(a, 'baseline-retry-001', { ...payload, quantity: 3 }), /IDEMPOTENCY_PAYLOAD_MISMATCH/)
    await assert.rejects(create(a, 'baseline-stock-fail', { ...payload, quantity: 100 }),
      error => /NEGATIVE_STOCK|STOCK_INSUFICIENTE/.test(error.message)
        || (error.code === '23514' && ['productos_stock_nonnegative_check', 'producto_variantes_stock_nonnegative_check'].includes(error.constraint)))
    assert.equal(await stock(), 18)
  })
  await check('external history constraint, direct write denial and SELECT preserved', async () => {
    const id = (await create(a, 'baseline-retry-001')).rows[0].id
    await assert.rejects(a.query('update external_sales set creation_request=null where id=$1', [id]), /EXTERNAL_SALE_CREATION_IMMUTABLE/)
    await assert.rejects(a.query("insert into external_sales(product_name,creation_idempotency_key) values('Invalid','valid-key')"), /external_sales_creation_request_check/)
    await db.query("set role authenticated; set request.jwt.claim.role='authenticated'")
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor])
    for (const sql of ['update external_sales set quantity=9', 'delete from external_sales', "insert into external_sales(product_name) values('Denied')"]) await assert.rejects(db.query(sql), /permission denied/)
    assert.equal((await db.query('select id from external_sales')).rowCount, 1)
    await db.query("reset role; set request.jwt.claim.role='service_role'")
  })
  await check('reverse wins edit race; history and stock preserved', async () => {
    const id = (await create(a, 'baseline-reverse-first')).rows[0].id
    const result = await race(c => reverse(c, id), c => edit(c, id))
    assert.ifError(result.error); assert.equal(result.value.rowCount, 0)
    await assert.rejects(a.query('update external_sales set quantity=9 where id=$1', [id]), /EXTERNAL_SALE_ALREADY_REVERSED/)
    await reverse(a, id)
    assert.equal(await stock(), 18)
  })
  await check('edit wins reverse race; reversal uses latest amount once', async () => {
    const id = (await create(a, 'baseline-edit-first')).rows[0].id
    const result = await race(c => edit(c, id), c => reverse(c, id))
    assert.ifError(result.error); assert.equal(Number(result.value.rows[0].reversal_amount), 150)
    await reverse(a, id)
    assert.equal(await stock(), 18)
  })
  const reversalCount = async id => (await db.query("select count(*)::int n from customer_credit_movements where order_id=$1 and movement_type='reversal'", [id])).rows[0].n
  const balance = async () => Number((await db.query('select get_customer_credit_balance($1) balance', [customer])).rows[0].balance)
  const assertReversal = async (id, previousBalance) => {
    const movements = (await db.query("select * from customer_credit_movements where order_id=$1 and movement_type='reversal'", [id])).rows
    assert.equal(movements.length, 1)
    const movement = movements[0]
    const debit = (await db.query("select id from customer_credit_movements where order_id=$1 and movement_type='debit'", [id])).rows[0]
    assert.equal(Number(movement.amount), 30)
    assert.equal(movement.user_id, customer); assert.equal(movement.created_by, actor)
    assert.equal(movement.related_movement_id, debit.id)
    assert.equal(movement.source_key, `order:${id}:customer-credit:reversal`)
    assert.equal(Number(movement.resulting_balance), previousBalance + 30)
    assert.equal(await balance(), previousBalance + 30)
    const row = (await db.query('select * from ordenes where id=$1', [id])).rows[0]
    assert.equal(Number(row.credit_balance_used), 0)
    assert.equal(Number(row.external_amount_due), 100)
    assert.equal(row.credit_balance_movement_id, null)
  }
  const assertAudit = async (id, action, previous, next) => {
    const events = (await db.query('select * from order_audit_events where order_id=$1 and action=$2', [id, action])).rows
    assert.equal(events.length, 1)
    assert.equal(events[0].actor_type, 'admin'); assert.equal(events[0].actor_id, actor)
    assert.equal(events[0].previous_status, previous); assert.equal(events[0].new_status, next)
    return events[0]
  }
  const assertNoLateConfirmation = async id => {
    const before = (await db.query('select * from ordenes where id=$1', [id])).rows[0]
    const auditBefore = (await db.query('select count(*)::int n from order_audit_events where order_id=$1', [id])).rows[0].n
    const balanceBefore = await balance()
    await assert.rejects(review(a, id), /TRANSFER_CANCELLATION_CONFLICT/)
    assert.deepEqual((await db.query('select * from ordenes where id=$1', [id])).rows[0], before)
    assert.equal((await db.query('select count(*)::int n from order_audit_events where order_id=$1', [id])).rows[0].n, auditBefore)
    assert.equal(await balance(), balanceBefore)
    assert.equal((await db.query(`select count(*)::int n from order_audit_events confirmed
      join order_audit_events cancelled on cancelled.order_id=confirmed.order_id
      where confirmed.order_id=$1 and confirmed.action='payment_confirmed'
      and cancelled.action in ('order_rejected_by_admin','order_cancelled_refund_pending')
      and confirmed.id > cancelled.id`, [id])).rows[0].n, 0)
  }
  await check('cancel wins transfer race; balance restored once, no confirmation', async () => {
    const id = await order()
    const previousBalance = await balance()
    const result = await race(c => cancel(c, id), c => review(c, id))
    assert.match(result.error?.message ?? '', /TRANSFER_CANCELLATION_CONFLICT/)
    const row = (await db.query('select * from ordenes where id=$1', [id])).rows[0]
    assert.equal(row.estado, 'cancelado'); assert.equal(row.financial_status, 'cancelled')
    assert.equal(Number(row.credit_balance_used), 0); assert.equal(Number(row.external_amount_due), 100)
    assert.equal((await db.query("select count(*)::int n from order_audit_events where order_id=$1 and action='payment_confirmed'", [id])).rows[0].n, 0)
    await assertReversal(id, previousBalance)
    await assertAudit(id, 'order_rejected_by_admin', 'payment_submitted', 'cancelled')
    await assertNoLateConfirmation(id)
  })
  await check('transfer wins rejection race; confirmation and audit are idempotent', async () => {
    const id = await order()
    const previousBalance = await balance()
    const result = await race(c => review(c, id), c => cancel(c, id))
    assert.match(result.error?.message ?? '', /ORDER_ALREADY_PAID_USE_CANCEL/)
    await review(a, id)
    assert.equal((await db.query("select count(*)::int n from order_audit_events where order_id=$1 and action='payment_confirmed'", [id])).rows[0].n, 1)
    assert.equal(await reversalCount(id), 0)
    assert.equal(await balance(), previousBalance)
    const confirmed = (await db.query('select * from ordenes where id=$1', [id])).rows[0]
    assert.equal(confirmed.estado, 'pagado'); assert.equal(confirmed.financial_status, 'payment_confirmed')
    assert.equal(Number(confirmed.payment_confirmed_amount), 70)
    const event = await assertAudit(id, 'payment_confirmed', 'payment_submitted', 'payment_confirmed')
    assert.equal(Number(event.metadata.externalAmount), 70)
    assert.equal(Number(event.metadata.creditBalanceUsed), 30)
    await cancel(a, id, 'cancel')
    assert.equal((await db.query('select financial_status from ordenes where id=$1', [id])).rows[0].financial_status, 'refund_pending')
    await assertReversal(id, previousBalance)
    await assertAudit(id, 'order_cancelled_refund_pending', 'payment_confirmed', 'refund_pending')
    await assertNoLateConfirmation(id)
  })
  await check('paid cancellation waits for transfer confirmation lock', async () => {
    const id = await order()
    const previousBalance = await balance()
    const result = await race(c => review(c, id), c => cancel(c, id, 'cancel'))
    assert.ifError(result.error)
    assert.equal(result.value.rows[0].financial_status, 'refund_pending')
    await assertReversal(id, previousBalance)
    await assertAudit(id, 'payment_confirmed', 'payment_submitted', 'payment_confirmed')
    await assertAudit(id, 'order_cancelled_refund_pending', 'payment_confirmed', 'refund_pending')
    await assertNoLateConfirmation(id)
  })
  await check('manual rejection returns credit once and audits once', async () => {
    const id = await order()
    const previousBalance = await balance()
    await review(a, id, 'rechazado'); await review(a, id, 'rechazado')
    await assertReversal(id, previousBalance)
    await assertAudit(id, 'payment_status_rechazado', 'payment_submitted', 'pending_payment')
  })
  writeFileSync(join(cluster, 'verification.json'), JSON.stringify({ checks, cluster, snapshotSha256: metadata.sha256 }, null, 2))
  console.log(`Local evidence: ${cluster}`)
} finally {
  await Promise.allSettled(clients.map(client => client.end()))
  if (started) run('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop'])
}
