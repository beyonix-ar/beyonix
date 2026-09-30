import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import {
  WSAA_LOCK_STALE_MS,
  WsaaLockTimeoutError,
  acquireWsaaLock,
  isWsaaAlreadyAuthenticatedFault,
  obtainWsaaTicket,
  readCachedTicket,
  releaseWsaaLock,
  writeCachedTicket,
  wsaaTicketCacheDir,
  wsaaTicketCacheKey,
  wsaaTicketCachePath,
  type WsaaTicketScope,
} from "./wsaa-ticket-cache.ts"

// TA de WSAA persistido y compartido entre procesos del servidor: se
// reutiliza siempre el vigente y nunca dos procesos piden uno a la vez.

const CERT = "-----BEGIN CERTIFICATE-----\nMIIDtest\n-----END CERTIFICATE-----"
const MARGIN = 5 * 60 * 1000
const now = Date.parse("2026-09-27T18:00:00.000Z")
const HOMOLOGATION: WsaaTicketScope = { environment: "homologation", service: "wsfe", certificatePem: CERT }
const PRODUCTION: WsaaTicketScope = { ...HOMOLOGATION, environment: "production" }
const ticket = {
  token: "PD94bWwgdG9rZW4=",
  sign: "c2lnbg==",
  generationTime: "2026-09-27T15:00:00.000-03:00",
  expirationTime: "2026-09-28T03:00:00.000-03:00",
}
const posix = process.platform !== "win32"

async function withDir(run: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "beyonix-wsaa-"))
  try {
    await run(join(dir, "cache"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("directorio por defecto fuera de la app (no depende de cwd): PM2 y scripts del mismo usuario lo comparten", () => {
  const previous = process.env.ARCA_TA_CACHE_DIR
  delete process.env.ARCA_TA_CACHE_DIR
  try {
    const dir = wsaaTicketCacheDir()
    assert.match(dir, /[\\/]\.beyonix[\\/]arca-wsaa$/)
    assert.ok(!dir.startsWith(process.cwd()), "no vive dentro del repo/app")
  } finally {
    if (previous === undefined) delete process.env.ARCA_TA_CACHE_DIR
    else process.env.ARCA_TA_CACHE_DIR = previous
  }
})

test("persistido: otro proceso lo reutiliza; archivo 0600 en directorio 0700, sin temporales", async () => {
  await withDir((dir) => {
    assert.equal(readCachedTicket(HOMOLOGATION, now, MARGIN, dir), null)
    assert.equal(writeCachedTicket(HOMOLOGATION, ticket, dir), true)
    assert.deepEqual(readCachedTicket(HOMOLOGATION, now, MARGIN, dir), ticket)
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [])
    if (posix) {
      assert.equal(statSync(dir).mode & 0o777, 0o700)
      assert.equal(statSync(wsaaTicketCachePath(wsaaTicketCacheKey(HOMOLOGATION), dir)).mode & 0o777, 0o600)
    }
  })
})

test("separación por ambiente + servicio + certificado: un TA de homologación nunca sirve en producción", async () => {
  const scopes = [
    PRODUCTION,
    { ...HOMOLOGATION, service: "wsfex" },
    { ...HOMOLOGATION, certificatePem: CERT.replace("test", "otro") },
  ]
  const keys = new Set([HOMOLOGATION, ...scopes].map(wsaaTicketCacheKey))
  assert.equal(keys.size, 4)
  // Mismo certificado con CRLF: misma clave (el .env del VPS usa CRLF).
  assert.equal(wsaaTicketCacheKey({ ...HOMOLOGATION, certificatePem: CERT.replaceAll("\n", "\r\n") }), wsaaTicketCacheKey(HOMOLOGATION))
  await withDir((dir) => {
    writeCachedTicket(HOMOLOGATION, ticket, dir)
    for (const scope of scopes) assert.equal(readCachedTicket(scope, now, MARGIN, dir), null)
    // Aunque alguien copie el archivo de homologación con el nombre de producción.
    const production = wsaaTicketCachePath(wsaaTicketCacheKey(PRODUCTION), dir)
    writeFileSync(production, readFileSync(wsaaTicketCachePath(wsaaTicketCacheKey(HOMOLOGATION), dir)))
    assert.equal(readCachedTicket(PRODUCTION, now, MARGIN, dir), null)
  })
})

test("vencido, dentro del margen, corrupto o incompleto -> se ignora", async () => {
  await withDir((dir) => {
    writeCachedTicket(HOMOLOGATION, ticket, dir)
    const expiration = Date.parse(ticket.expirationTime)
    assert.equal(readCachedTicket(HOMOLOGATION, expiration + 1, MARGIN, dir), null)
    assert.equal(readCachedTicket(HOMOLOGATION, expiration - MARGIN + 1, MARGIN, dir), null)
    assert.deepEqual(readCachedTicket(HOMOLOGATION, expiration - MARGIN - 1, MARGIN, dir), ticket)
    const path = wsaaTicketCachePath(wsaaTicketCacheKey(HOMOLOGATION), dir)
    writeFileSync(path, "{no es json")
    assert.equal(readCachedTicket(HOMOLOGATION, now, MARGIN, dir), null)
    writeFileSync(path, JSON.stringify({ ...JSON.parse(JSON.stringify(ticket)), key: wsaaTicketCacheKey(HOMOLOGATION), environment: "homologation", service: "wsfe", token: "" }))
    assert.equal(readCachedTicket(HOMOLOGATION, now, MARGIN, dir), null)
  })
})

test("obtainWsaaTicket: reutiliza el persistido sin llamar a WSAA; si no hay, pide uno y lo persiste", async () => {
  await withDir(async (dir) => {
    let requests = 0
    const request = async () => {
      requests += 1
      return ticket
    }
    assert.deepEqual(await obtainWsaaTicket({ scope: HOMOLOGATION, request, marginMs: MARGIN, dir, now: () => now }), ticket)
    assert.deepEqual(await obtainWsaaTicket({ scope: HOMOLOGATION, request, marginMs: MARGIN, dir, now: () => now }), ticket)
    assert.equal(requests, 1)
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".lock")), [], "libera el candado")
  })
})

test("candado: sólo el dueño lo libera; uno huérfano (proceso muerto) se descarta; uno activo hace esperar", async () => {
  await withDir(async (dir) => {
    const mine = acquireWsaaLock(HOMOLOGATION, now, dir)
    assert.ok(mine)
    assert.equal(acquireWsaaLock(HOMOLOGATION, now, dir), null, "exclusivo")
    releaseWsaaLock(HOMOLOGATION, "otro-proceso", dir)
    assert.equal(acquireWsaaLock(HOMOLOGATION, now, dir), null, "otro no puede liberarlo")

    // Activo y nadie persiste: espera y falla sin pedir TA.
    let requests = 0
    let clock = now
    await assert.rejects(
      obtainWsaaTicket({
        scope: HOMOLOGATION,
        request: async () => { requests += 1; return ticket },
        marginMs: MARGIN,
        dir,
        now: () => clock,
        sleep: async (ms) => { clock += ms },
        waitTimeoutMs: 2_000,
      }),
      WsaaLockTimeoutError,
    )
    assert.equal(requests, 0)

    // Huérfano: más viejo que el umbral -> se toma.
    const lock = join(dir, readdirSync(dir).find((name) => name.endsWith(".lock"))!)
    const old = new Date(Date.now() - WSAA_LOCK_STALE_MS - 1_000)
    utimesSync(lock, old, old)
    assert.ok(acquireWsaaLock(HOMOLOGATION, Date.now(), dir))
  })
})

test("un error de WSAA libera el candado y no deja nada persistido", async () => {
  await withDir(async (dir) => {
    await assert.rejects(
      obtainWsaaTicket({
        scope: HOMOLOGATION,
        request: async () => { throw new Error("WSAA rechazó la autenticación: El CEE ya posee un TA valido para el acceso al WSN solicitado.") },
        marginMs: MARGIN,
        dir,
        now: () => now,
      }),
      /ya posee un TA valido/,
    )
    assert.equal(readCachedTicket(HOMOLOGATION, now, MARGIN, dir), null)
    assert.ok(acquireWsaaLock(HOMOLOGATION, now, dir), "el candado quedó libre")
  })
})

test("procesos reales en paralelo sin TA: WSAA recibe UN solo login y todos usan el mismo ticket", async () => {
  await withDir(async (dir) => {
    const log = join(dir, "..", "requests.log")
    writeFileSync(log, "")
    const moduleUrl = pathToFileURL(join(process.cwd(), "lib/arca/wsaa-ticket-cache.ts")).href
    const worker = `
      import { appendFileSync } from "node:fs"
      const { obtainWsaaTicket } = await import(${JSON.stringify(moduleUrl)})
      const ticket = await obtainWsaaTicket({
        scope: ${JSON.stringify(HOMOLOGATION)},
        marginMs: ${MARGIN},
        dir: ${JSON.stringify(dir)},
        pollMs: 20,
        request: async () => {
          appendFileSync(${JSON.stringify(log)}, process.pid + "\\n")
          await new Promise((resolve) => setTimeout(resolve, 400))
          return { token: "T-" + process.pid, sign: "S", generationTime: "x", expirationTime: new Date(Date.now() + 3600e3).toISOString() }
        },
      })
      process.stdout.write(ticket.token)
    `
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", worker], { stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      let err = ""
      child.stdout.on("data", (chunk) => { out += chunk })
      child.stderr.on("data", (chunk) => { err += chunk })
      child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err))))
    })
    const tokens = await Promise.all([run(), run(), run(), run()])
    const logins = readFileSync(log, "utf8").split("\n").filter(Boolean)
    assert.equal(logins.length, 1, "un solo login a WSAA")
    assert.equal(new Set(tokens).size, 1, "todos usan el mismo TA")
    assert.equal(tokens[0], `T-${logins[0]}`)
  })
})

test("reconoce el rechazo real de WSAA por TA duplicado", () => {
  assert.equal(isWsaaAlreadyAuthenticatedFault("El CEE ya posee un TA valido para el acceso al WSN solicitado"), true)
  assert.equal(isWsaaAlreadyAuthenticatedFault("ns1:coe.alreadyAuthenticated"), true)
  assert.equal(isWsaaAlreadyAuthenticatedFault("Certificado expirado"), false)
})

test("wsaa.ts y wsfe.ts toman el ambiente de una sola fuente; el TA va por obtainWsaaTicket", () => {
  const wsaa = readFileSync("lib/arca/wsaa.ts", "utf8")
  // Ambiente, certificado y endpoint salen de la configuración validada.
  assert.match(wsaa, /getWsaaCredentials\(configuration: ArcaConfiguration = requireArcaConfiguration\(\)\)/)
  assert.match(wsaa, /environment: configuration\.environment,/)
  assert.match(wsaa, /fetch\(WSAA_URLS\[configuration\.environment\]/)
  assert.match(wsaa, /obtainWsaaTicket\(\{/)
  assert.match(wsaa, /request: \(\) => requestCredentials\(configuration\),/)
  assert.equal(
    wsaa.match(/requestCredentials\(/g)?.length,
    2,
    "declaración + el único llamado dentro de obtainWsaaTicket: nunca se llama a WSAA por fuera del candado",
  )
  assert.match(readFileSync("lib/arca/wsfe.ts", "utf8"), /return getConfiguredArcaEnvironment\(\)/)
  for (const file of ["lib/arca/wsaa.ts", "lib/arca/wsfe.ts", "lib/arca/wsfe-invoice-gateway.ts", "lib/arca/invoice-automation.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /process\.env\.ARCA_ENV/, `${file}: ambiente sólo desde environment.ts`)
  }
})
