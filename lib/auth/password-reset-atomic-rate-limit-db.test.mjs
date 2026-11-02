import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from '../fixtures/isolated-postgres.mjs'

// Rate limit atómico de "olvidé mi contraseña" (20261101120000) sobre
// PostgreSQL REAL con conexiones concurrentes. Para que la concurrencia no sea
// secuencial disfrazada, cada ráfaga arranca con todas las solicitudes ya en
// vuelo y BLOQUEADAS en el mismo advisory lock (verificado en pg_locks); recién
// entonces se libera la compuerta y compiten entre sí.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const baseMigration = read('../../supabase/migrations/20260905090000_password_reset_rate_limit.sql')
const atomicMigration = read('../../supabase/migrations/20261101120000_password_reset_atomic_rate_limit.sql')

const LOCK_IDENTIFIER = 731001
const LOCK_IP = 731002
const sha = (value) => createHash('sha256').update(value).digest('hex')

test('rate limit atómico de recuperación (PostgreSQL real)', { timeout: 240000 }, async (t) => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-password-reset-rl-pg')
  const clients = []
  const connect = async () => {
    const client = server.getPgClient('postgres', '127.0.0.1')
    await client.connect()
    clients.push(client)
    await client.query("set statement_timeout = '20s'")
    return client
  }

  try {
    await server.initialise(); await server.start()
    const db = await connect()
    await db.query('create role anon; create role authenticated; create role service_role bypassrls;')

    // Esquema actual + datos existentes ANTES de la migración nueva.
    await db.query(baseMigration)
    const legacyIdentifier = sha('legacy-user')
    await db.query(
      "insert into public.password_reset_attempts(identifier_hash, ip_hash, created_at) values ($1, $2, now() - interval '30 minutes'), ($1, null, now() - interval '3 days')",
      [legacyIdentifier, sha('198.51.100.1')],
    )
    await db.query(atomicMigration)

    // Pool de conexiones que actúan como el backend (service_role).
    const pool = []
    for (let i = 0; i < 14; i++) {
      const client = await connect()
      await client.query('set role service_role')
      pool.push(client)
    }

    const admit = (client, identifierHash, ipHash) =>
      client.query('select public.admit_password_reset_attempt($1, $2) as allowed', [identifierHash, ipHash])
        .then((result) => result.rows[0].allowed)

    const waitingAdvisoryLocks = async () => Number((await db.query(
      "select count(*)::int n from pg_locks where locktype = 'advisory' and not granted")).rows[0].n)

    /**
     * Toma la compuerta (mismo advisory lock que la función) en una
     * transacción, dispara todas las solicitudes, espera a que estén TODAS
     * bloqueadas y recién ahí libera.
     */
    const burst = async (gate, requests) => {
      const gateClient = await connect()
      await gateClient.query('begin')
      await gateClient.query('select pg_advisory_xact_lock($1, hashtext($2))', gate)
      const pending = requests.map(([identifierHash, ipHash], index) => admit(pool[index], identifierHash, ipHash))
      const deadline = Date.now() + 15000
      while (await waitingAdvisoryLocks() < requests.length) {
        assert.ok(Date.now() < deadline, 'las solicitudes no llegaron a quedar en vuelo a la vez')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await gateClient.query('commit')
      const results = await Promise.all(pending)
      return { admitted: results.filter(Boolean).length, limited: results.filter((allowed) => !allowed).length }
    }

    const attempts = async (column, hash) => Number((await db.query(
      `select count(*)::int n from public.password_reset_attempts where ${column} = $1`, [hash])).rows[0].n)

    await t.test('migración: crea la RPC, grants sólo para service_role y conserva datos existentes', async () => {
      const privileges = (await db.query(`
        select r.role, has_function_privilege(r.role, 'public.admit_password_reset_attempt(text, text)', 'execute') as can
        from unnest(array['anon', 'authenticated', 'service_role']) as r(role)`)).rows
      assert.deepEqual(Object.fromEntries(privileges.map((row) => [row.role, row.can])),
        { anon: false, authenticated: false, service_role: true })
      const publicGrant = (await db.query(`
        select count(*)::int n from pg_proc p, aclexplode(p.proacl) a
        where p.proname = 'admit_password_reset_attempt' and a.grantee = 0`)).rows[0].n
      assert.equal(publicGrant, 0, 'PUBLIC no debe tener EXECUTE')
      assert.equal(await attempts('identifier_hash', legacyIdentifier), 2)

      const anonClient = await connect()
      await anonClient.query('set role anon')
      await assert.rejects(admit(anonClient, sha('x'), null), /permission denied/)

      await assert.rejects(admit(pool[0], 'no-es-un-hash', null), /invalid identifier hash/)
      await assert.rejects(admit(pool[0], sha('x'), 'no-es-un-hash'), /invalid ip hash/)
    })

    await t.test('10 solicitudes paralelas del mismo identificador (sin IP): 3 admitidas, 7 limitadas', async () => {
      const identifier = sha('mismo-usuario')
      const result = await burst([LOCK_IDENTIFIER, identifier], Array.from({ length: 10 }, () => [identifier, null]))
      console.log('mismo identificador:', result)
      assert.deepEqual(result, { admitted: 3, limited: 7 })
      assert.equal(await attempts('identifier_hash', identifier), 10, 'todos los intentos quedan registrados')
    })

    await t.test('12 identificadores distintos desde la misma IP en paralelo: 8 admitidas, 4 limitadas', async () => {
      const ip = sha('203.0.113.50')
      const requests = Array.from({ length: 12 }, (_, index) => [sha(`usuario-ip-${index}`), ip])
      const result = await burst([LOCK_IP, ip], requests)
      console.log('misma IP:', result)
      assert.deepEqual(result, { admitted: 8, limited: 4 })
      assert.equal(await attempts('ip_hash', ip), 12)
    })

    await t.test('mismo identificador + misma IP: manda el límite más restrictivo', async () => {
      const ip = sha('203.0.113.60')
      // La IP ya tiene 6 intentos en la última hora (otros usuarios): le quedan 2.
      for (let index = 0; index < 6; index++) await admit(pool[0], sha(`previo-${index}`), ip)
      const identifier = sha('usuario-combinado')
      const result = await burst([LOCK_IDENTIFIER, identifier], Array.from({ length: 6 }, () => [identifier, ip]))
      console.log('identificador + IP:', result)
      assert.deepEqual(result, { admitted: 2, limited: 4 })
    })

    await t.test('límite diario por identificador también es atómico', async () => {
      const identifier = sha('usuario-diario')
      await db.query(
        "insert into public.password_reset_attempts(identifier_hash, created_at) select $1, now() - interval '2 hours' from generate_series(1, 4)",
        [identifier])
      const result = await burst([LOCK_IDENTIFIER, identifier], Array.from({ length: 6 }, () => [identifier, null]))
      console.log('límite diario:', result)
      assert.deepEqual(result, { admitted: 2, limited: 4 })
    })

    await t.test('identificadores e IPs distintos no se bloquean entre sí (locks granulares, sin lock global)', async () => {
      // Un lock tomado sobre OTRO identificador y OTRA IP no frena la función.
      const holder = await connect()
      await holder.query('begin')
      await holder.query('select pg_advisory_xact_lock($1, hashtext($2))', [LOCK_IDENTIFIER, sha('bloqueado')])
      await holder.query('select pg_advisory_xact_lock($1, hashtext($2))', [LOCK_IP, sha('192.0.2.200')])
      const startedAt = Date.now()
      assert.equal(await admit(pool[0], sha('libre'), sha('192.0.2.201')), true)
      assert.ok(Date.now() - startedAt < 2000, 'otra clave no debe esperar al lock ajeno')
      await holder.query('commit')

      // 10 usuarios distintos con IPs distintas, en paralelo: todos admitidos.
      const requests = Array.from({ length: 10 }, (_, index) => [sha(`paralelo-${index}`), sha(`192.0.2.${index}`)])
      const results = await Promise.all(requests.map(([identifier, ip], index) => admit(pool[index], identifier, ip)))
      console.log('distintos:', { admitted: results.filter(Boolean).length, limited: results.filter((allowed) => !allowed).length })
      assert.equal(results.every(Boolean), true)
    })

    await t.test('control: la misma función SIN advisory locks sí deja pasar la race (el arnés la detecta)', async () => {
      const naive = atomicMigration
        .replace(/^begin;$/m, '').replace(/^commit;$/m, '')
        .replace(/^(revoke|grant|comment)[\s\S]*?;$/gm, '')
        .replaceAll('public.admit_password_reset_attempt', 'public.naive_password_reset_attempt')
        .replace(/  perform pg_advisory_xact_lock[\s\S]*?end if;\n/, '')
        .replace('  insert into public.password_reset_attempts', '  perform pg_sleep(0.3);\n  insert into public.password_reset_attempts')
      assert.doesNotMatch(naive, /pg_advisory_xact_lock/)
      await db.query(naive)
      await db.query('grant execute on function public.naive_password_reset_attempt(text, text) to service_role')

      const identifier = sha('control-sin-lock')
      const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        pool[index].query('select public.naive_password_reset_attempt($1, null) as allowed', [identifier])
          .then((result) => result.rows[0].allowed)))
      const admitted = results.filter(Boolean).length
      console.log('control sin lock:', { admitted, limited: 10 - admitted })
      assert.ok(admitted > 3, `sin locks deberían colarse más de 3 (admitidas: ${admitted})`)
      await db.query('drop function public.naive_password_reset_attempt(text, text)')
    })

    await t.test('la RPC devuelve sólo un boolean', async () => {
      const columns = (await pool[0].query('select * from public.admit_password_reset_attempt($1, null)', [sha('forma')])).fields
      assert.equal(columns.length, 1)
      const returnType = (await db.query(
        "select pg_get_function_result('public.admit_password_reset_attempt(text, text)'::regprocedure) as type")).rows[0].type
      assert.equal(returnType, 'boolean')
    })
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
    await stopIsolatedPostgres(server, databaseDir)
  }
})
