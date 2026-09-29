import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createIsolatedPostgres, stopIsolatedPostgres } from './isolated-postgres.mjs'

// Regresión del cuelgue de teardown: el apagado debe ser el de PostgreSQL
// (postmaster.pid eliminado, pipes cerrados), no un kill forzado que deje
// hijos huérfanos reteniendo el proceso de Node.
test('PostgreSQL aislado: apagado limpio, pipes cerrados e idempotente', { timeout: 120000 }, async () => {
  const { server, databaseDir } = await createIsolatedPostgres('beyonix-isolated-pg')
  const client = server.getPgClient('postgres', '127.0.0.1')
  try {
    await server.initialise(); await server.start()
    await client.connect()
    // Fuerza a que existan backends e io workers antes de apagar.
    assert.equal((await client.query('select 1 as ok')).rows[0].ok, 1)
  } finally {
    await client.end().catch(() => undefined)
    const child = server.process
    await stopIsolatedPostgres(server, databaseDir)
    assert.equal(server.process, undefined)
    assert.ok(child && child.exitCode !== null, 'el postmaster terminó')
    assert.equal(child.stderr?.readableEnded || child.stderr?.destroyed, true, 'stderr cerrado: no quedan hijos con el pipe')
    assert.equal(existsSync(join(databaseDir, 'postmaster.pid')), false, 'apagado propio de PostgreSQL, no un kill forzado')
    await stopIsolatedPostgres(server, databaseDir)
  }
})
