import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'

// PostgreSQL real y aislado para tests de concurrencia.
//
// Apagado: embedded-postgres.stop() en Windows ejecuta `taskkill /f /t` sobre
// el postmaster. Con PostgreSQL 18 el postmaster tiene hijos (io_worker) que
// heredan su stderr; si taskkill mata al padre antes de enumerar a los hijos,
// éstos quedan huérfanos con el pipe abierto y el proceso de Node nunca
// termina aunque todos los tests hayan pasado. `pg_ctl stop -m fast -w` es el
// apagado propio de PostgreSQL: termina el postmaster y todos sus hijos, y
// recién entonces se cierran los pipes ('close').

// Mismo mapeo que embedded-postgres/dist/binary.js (no exportado por el paquete).
const PLATFORM_PACKAGE = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`

async function freePort() {
  const socket = createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const { port } = socket.address()
  await new Promise((resolve) => socket.close(resolve))
  return port
}

/** Crea (sin iniciar) un cluster en un directorio temporal propio. */
export async function createIsolatedPostgres(prefix) {
  const databaseDir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const server = new EmbeddedPostgres({
    databaseDir, port: await freePort(), user: 'postgres', password: 'isolated-test', persistent: true,
    postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {},
  })
  return { server, databaseDir }
}

/** Apagado limpio: postmaster + hijos terminados y pipes cerrados. Falla si PostgreSQL no se detiene. */
export async function stopIsolatedPostgres(server, databaseDir) {
  const child = server.process
  if (!child) return
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close')
    const { pg_ctl: pgCtl } = await import(PLATFORM_PACKAGE)
    const result = spawnSync(pgCtl, ['stop', '-D', databaseDir, '-m', 'fast', '-w'], { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`pg_ctl stop falló (${result.status}): ${result.stderr || result.stdout || result.error?.message}`)
    }
    await closed
  }
  server.process = undefined
}
