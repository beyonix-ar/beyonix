import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  AndreaniClient,
  AndreaniError,
  getAndreaniConfigurationStatus,
  resetAndreaniRuntimeStateForTests,
  resolveAndreaniConfig,
  verifyAndreaniAuthentication,
} from "../andreani/client.ts"
import { inspectArcaConfiguration } from "../arca/configuration.ts"
import { TEST_CUIT, arcaTestEnv, createArcaTestCredentials, createTestKeyPem } from "../arca/fixtures/arca-test-certificates.ts"
import {
  checkAndreaniHealth,
  checkArcaHealth,
  checkMercadoPagoHealth,
  checkStoreHealth,
  createSystemHealthCache,
  runSystemHealthChecks,
  systemHealthCacheKey,
  systemHealthFingerprint,
  type ArcaHealthDependencies,
  type StoreHealthDependencies,
  type SystemHealthDependencies,
} from "./system-health-checks.ts"

// Health checks de "Estado de integraciones": todo READ-ONLY y sin red real.

const DAY_MS = 24 * 60 * 60 * 1000
const MP_TOKEN = ["APP_USR", "1234567890", "token-secreto-de-prueba"].join("-")
const SETTINGS_URL = "https://beyonix.test/api/store/settings"

function liveSignal() {
  return new AbortController().signal
}

function abortedSignal() {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

/** fetch que nunca responde y sólo rechaza al abortarse (timeout real). */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException("Abortado", "AbortError"))
    if (init?.signal?.aborted) abort()
    init?.signal?.addEventListener("abort", abort)
  })

// ---------------------------------------------------------------- Tienda

function storeDeps(overrides: Partial<StoreHealthDependencies> = {}): StoreHealthDependencies {
  return {
    readDatabase: async () => ({ error: null }),
    publicSettingsUrl: SETTINGS_URL,
    fetch: async () =>
      Response.json({ settings: { shipping: {} } }, { headers: { "X-Settings-Source": "database" } }),
    ...overrides,
  }
}

test("tienda: base OK + API OK -> Operativo con el texto exacto", async () => {
  const requested: string[] = []
  const result = await checkStoreHealth(storeDeps({
    fetch: async (input, init) => {
      requested.push(`${init?.method ?? "GET"} ${String(input)}`)
      return Response.json({ settings: {} }, { headers: { "X-Settings-Source": "database" } })
    },
  }), liveSignal())
  assert.deepEqual(result, { status: "ok", detail: "API pública y base de datos respondieron correctamente." })
  assert.deepEqual(requested, [`GET ${SETTINGS_URL}`], "sólo una lectura pública, sin escrituras")
})

test("tienda: base de datos falla o se cuelga -> Caído", async () => {
  const failed = await checkStoreHealth(storeDeps({ readDatabase: async () => ({ error: { message: "boom" } }) }), liveSignal())
  assert.equal(failed.status, "error")
  assert.match(failed.detail, /base de datos no respondió correctamente/)
  assert.doesNotMatch(failed.detail, /boom/, "nunca reenvía el mensaje interno")

  const thrown = await checkStoreHealth(storeDeps({ readDatabase: async () => { throw new Error("socket") } }), liveSignal())
  assert.equal(thrown.status, "error")

  const timedOut = await checkStoreHealth(
    storeDeps({ readDatabase: async () => ({ error: { message: "AbortError" } }), fetch: hangingFetch }),
    abortedSignal(),
  )
  assert.equal(timedOut.status, "error")
  assert.match(timedOut.detail, /no respondió a tiempo/)
})

test("tienda: API pública con HTTP de error, timeout, red o JSON inválido -> Caído", async () => {
  const http = await checkStoreHealth(storeDeps({ fetch: async () => new Response("detalle", { status: 503 }) }), liveSignal())
  assert.deepEqual(http, { status: "error", detail: "La API pública respondió HTTP 503." })

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5)
  const timeout = await checkStoreHealth(storeDeps({ fetch: hangingFetch }), controller.signal)
  assert.deepEqual(timeout, { status: "error", detail: "La API pública no respondió a tiempo." })

  const network = await checkStoreHealth(storeDeps({ fetch: async () => { throw new TypeError("fetch failed") } }), liveSignal())
  assert.deepEqual(network, { status: "error", detail: "No se pudo conectar con la API pública." })

  const invalid = await checkStoreHealth(storeDeps({ fetch: async () => new Response("<html>", { status: 200 }) }), liveSignal())
  assert.deepEqual(invalid, { status: "error", detail: "La API pública devolvió una respuesta inválida." })
})

test("tienda: fallback silencioso de store/settings se distingue (Degradado)", async () => {
  const result = await checkStoreHealth(storeDeps({
    fetch: async () => Response.json({ settings: {} }, { headers: { "X-Settings-Source": "fallback" } }),
  }), liveSignal())
  assert.equal(result.status, "warning")
  assert.match(result.detail, /valores de respaldo/)
})

test("tienda C/D: X-Settings-Source ausente o desconocido nunca es Operativo", async () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{}, "ausente"],
    [{ "X-Settings-Source": "cache" }, "desconocido"],
    [{ "X-Settings-Source": "DATABASE" }, "mayúsculas no válidas"],
    [{ "X-Settings-Source": "" }, "vacío"],
  ]
  for (const [headers, name] of cases) {
    const result = await checkStoreHealth(storeDeps({
      fetch: async () => Response.json({ settings: {} }, { headers }),
    }), liveSignal())
    assert.notEqual(result.status, "ok", name)
    assert.equal(result.status, "warning", name)
    assert.match(result.detail, /no informó el origen/, name)
  }
})

test("tienda: sin URL pública confiable no se finge la verificación de la API", async () => {
  let fetched = false
  const result = await checkStoreHealth(storeDeps({
    publicSettingsUrl: null,
    fetch: async () => { fetched = true; return Response.json({}) },
  }), liveSignal())
  assert.equal(result.status, "warning")
  assert.match(result.detail, /no se verificó la API pública/)
  assert.equal(fetched, false)
})

// ---------------------------------------------------------- Mercado Pago

function mercadoPago(fetchImpl: typeof fetch, accessToken: string | undefined = MP_TOKEN) {
  return { accessToken, fetch: fetchImpl }
}

test("mercado pago: sin token -> Deshabilitado y sin llamadas", async () => {
  let called = false
  for (const token of [undefined, "", "   "]) {
    const result = await checkMercadoPagoHealth(
      { accessToken: token, fetch: async () => { called = true; return Response.json({}) } },
      liveSignal(),
    )
    assert.deepEqual(result, { status: "disabled", detail: "No hay credenciales configuradas." })
  }
  assert.equal(called, false)
})

test("mercado pago: token válido -> sólo GET /users/me y texto preciso (no 'listo para cobrar')", async () => {
  const calls: Array<{ url: string; method: string; auth: string | null }> = []
  const result = await checkMercadoPagoHealth(mercadoPago(async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") })
    return Response.json({ id: 123456, email: "comercio@example.com", nickname: "BEYONIX" })
  }), liveSignal())
  assert.deepEqual(result, { status: "ok", detail: "API y autenticación de la cuenta verificadas correctamente." })
  assert.deepEqual(calls, [{ url: "https://api.mercadopago.com/users/me", method: "GET", auth: `Bearer ${MP_TOKEN}` }])
  assert.doesNotMatch(result.detail, /cobrar|listo/i)
})

test("mercado pago: 401/403/429/5xx/otros se clasifican sin exponer cuerpo ni token", async () => {
  const cases: Array<[number, string, RegExp]> = [
    [401, "error", /rechazó las credenciales \(HTTP 401\)/],
    [403, "error", /rechazó las credenciales \(HTTP 403\)/],
    [429, "warning", /limitó temporalmente/],
    [500, "error", /no está disponible \(HTTP 500\)/],
    [503, "error", /no está disponible \(HTTP 503\)/],
    [404, "error", /respondió HTTP 404/],
  ]
  for (const [status, expected, detail] of cases) {
    const result = await checkMercadoPagoHealth(
      mercadoPago(async () => Response.json({ message: `secreto-del-cuerpo ${MP_TOKEN}` }, { status })),
      liveSignal(),
    )
    assert.equal(result.status, expected, `HTTP ${status}`)
    assert.match(result.detail, detail)
    assert.ok(!JSON.stringify(result).includes("secreto-del-cuerpo"))
    assert.ok(!JSON.stringify(result).includes(MP_TOKEN))
  }
})

test("mercado pago: timeout, red caída y respuesta inválida", async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5)
  const timeout = await checkMercadoPagoHealth(mercadoPago(hangingFetch), controller.signal)
  assert.equal(timeout.status, "error")
  assert.match(timeout.detail, /no respondió en 5 s/)

  const network = await checkMercadoPagoHealth(mercadoPago(async () => { throw new TypeError("getaddrinfo ENOTFOUND") }), liveSignal())
  assert.deepEqual(network, { status: "error", detail: "No se pudo conectar con Mercado Pago." })

  for (const body of ["no-json", JSON.stringify({}), JSON.stringify({ id: "abc" }), JSON.stringify({ id: -1 })]) {
    const invalid = await checkMercadoPagoHealth(mercadoPago(async () => new Response(body, { status: 200 })), liveSignal())
    assert.equal(invalid.status, "warning", body)
    assert.match(invalid.detail, /formato inesperado/)
  }
})

test("mercado pago: credenciales TEST- (sandbox) no se muestran como Operativo", async () => {
  const result = await checkMercadoPagoHealth(
    mercadoPago(async () => Response.json({ id: 1 }), "TEST-123-abc"),
    liveSignal(),
  )
  assert.equal(result.status, "warning")
  assert.match(result.detail, /credenciales de prueba/)
})

// -------------------------------------------------------------- Andreani

function andreaniEnv(environment: "QA" | "PROD", overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return environment === "QA"
    ? {
        NODE_ENV: "test",
        ANDREANI_ENV: "QA",
        ANDREANI_QA_API_URL: "https://apisqa.andreani.com",
        ANDREANI_QA_USERNAME: "usuario-qa-health",
        ANDREANI_QA_PASSWORD: "clave-qa-health",
        ...overrides,
      }
    : {
        NODE_ENV: "test",
        ANDREANI_ENV: "PROD",
        ANDREANI_PROD_API_URL: "https://apis.andreani.com",
        ANDREANI_PROD_USERNAME: "usuario-prod-health",
        ANDREANI_PROD_PASSWORD: "clave-prod-health",
        ...overrides,
      }
}

function andreaniDeps(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch) {
  const calls: string[] = []
  const recordingFetch: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`)
    return fetchImpl(input, init)
  }
  return {
    calls,
    deps: {
      env,
      verify: (timeoutMs: number) => verifyAndreaniAuthentication({ env, fetch: recordingFetch, timeoutMs }),
    } satisfies SystemHealthDependencies["andreani"],
  }
}

const loginOk: typeof fetch = async () => Response.json({ token: "token-de-health" })

test("andreani QA: configuración válida + login real -> Operativo, sin afirmar contratos ni envíos", async () => {
  resetAndreaniRuntimeStateForTests()
  const { deps, calls } = andreaniDeps(andreaniEnv("QA"), loginOk)
  const result = await checkAndreaniHealth(deps)
  assert.deepEqual(result, { status: "ok", detail: "Login y credenciales verificadas correctamente (QA)." })
  assert.deepEqual(calls, ["GET /login"], "health NO crea envío ni tarifa")
  assert.doesNotMatch(result.detail, /contrato|sucursal|envío|tarifa/i)
})

test("andreani PROD: configuración válida no falla por el guard operativo y sólo hace GET /login", async () => {
  resetAndreaniRuntimeStateForTests()
  const env = andreaniEnv("PROD")
  assert.equal(getAndreaniConfigurationStatus(env).configured, true, "validez de configuración sin guard")
  assert.throws(
    () => resolveAndreaniConfig(env),
    (error: unknown) => error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
    "el guard de operaciones PROD sigue intacto",
  )

  const { deps, calls } = andreaniDeps(env, loginOk)
  const result = await checkAndreaniHealth(deps)
  assert.deepEqual(result, { status: "ok", detail: "Login y credenciales verificadas correctamente (PROD)." })
  assert.deepEqual(calls, ["GET /login"])
})

test("andreani PROD: la capacidad de health no habilita ninguna otra operación", async () => {
  resetAndreaniRuntimeStateForTests()
  let networkCalls = 0
  const client = new AndreaniClient({
    env: andreaniEnv("PROD"),
    productionAccess: "authentication-check",
    fetch: async () => { networkCalls += 1; return Response.json({ token: "x" }) },
  })
  await assert.rejects(
    () => client.getPuntosDeTercero({ contrato: "CONTRATO-PROD" }),
    (error: unknown) => error instanceof AndreaniError && error.code === "PRODUCTION_BLOCKED",
  )
  assert.equal(networkCalls, 0)
})

test("andreani: credenciales incorrectas, proveedor caído, timeout y respuesta sin token", async () => {
  const cases: Array<[typeof fetch, string, RegExp]> = [
    [async () => new Response("usuario-qa-health inválido", { status: 401 }), "error", /rechazó las credenciales/],
    [async () => new Response("", { status: 503 }), "error", /no está disponible \(HTTP 503\)/],
    [async () => { throw new TypeError("fetch failed") }, "error", /No se pudo conectar con Andreani/],
    [async () => Response.json({}), "warning", /sin un token válido/],
  ]
  for (const [fetchImpl, status, detail] of cases) {
    resetAndreaniRuntimeStateForTests()
    const { deps } = andreaniDeps(andreaniEnv("QA"), fetchImpl)
    const result = await checkAndreaniHealth(deps)
    assert.equal(result.status, status)
    assert.match(result.detail, detail)
    assert.doesNotMatch(JSON.stringify(result), /usuario-qa-health|clave-qa-health/)
  }

  resetAndreaniRuntimeStateForTests()
  const env = andreaniEnv("QA")
  const timeout = await checkAndreaniHealth({
    env,
    verify: () => verifyAndreaniAuthentication({ env, fetch: hangingFetch, timeoutMs: 5 }),
  })
  assert.equal(timeout.status, "error")
  assert.match(timeout.detail, /no respondió en 6 s/)
})

test("andreani: un token cacheado vigente NO falsea el health actual", async () => {
  resetAndreaniRuntimeStateForTests()
  const env = andreaniEnv("QA")
  await new AndreaniClient({ env, fetch: loginOk }).authenticate()

  let logins = 0
  const result = await checkAndreaniHealth({
    env,
    verify: (timeoutMs) => verifyAndreaniAuthentication({
      env,
      timeoutMs,
      fetch: async () => { logins += 1; return new Response("", { status: 401 }) },
    }),
  })
  assert.equal(logins, 1, "fuerza un login real aunque haya token cacheado")
  assert.equal(result.status, "error")
})

test("andreani E: si cambia la contraseña, el token cacheado de la anterior no se reutiliza", async () => {
  resetAndreaniRuntimeStateForTests()
  const before = andreaniEnv("QA")
  await new AndreaniClient({ env: before, fetch: loginOk }).authenticate()

  let reused = 0
  const sameCredentials = await new AndreaniClient({
    env: before,
    fetch: async () => { reused += 1; return loginOk("") },
  }).authenticate()
  assert.equal(sameCredentials, "token-de-health")
  assert.equal(reused, 0, "control: mismas credenciales usan el token cacheado")

  for (const rotated of [
    andreaniEnv("QA", { ANDREANI_QA_PASSWORD: "clave-qa-rotada" }),
    andreaniEnv("QA", { ANDREANI_QA_USERNAME: "usuario-qa-rotado" }),
  ]) {
    let logins = 0
    const token = await new AndreaniClient({
      env: rotated,
      fetch: async () => { logins += 1; return Response.json({ token: "token-nuevo" }) },
    }).authenticate()
    assert.equal(logins, 1, "credenciales nuevas => login nuevo")
    assert.equal(token, "token-nuevo")
  }
})

test("andreani: sin ANDREANI_ENV -> Deshabilitado; configuración incompleta -> Caído sin contactar", async () => {
  let verified = false
  const disabled = await checkAndreaniHealth({ env: { NODE_ENV: "test" }, verify: async () => { verified = true } })
  assert.equal(disabled.status, "disabled")

  const invalid = await checkAndreaniHealth({
    env: andreaniEnv("PROD", { ANDREANI_PROD_API_URL: "https://apisqa.andreani.com" }),
    verify: async () => { verified = true },
  })
  assert.equal(invalid.status, "error")
  assert.match(invalid.detail, /Configuración inválida/)
  assert.equal(verified, false)
})

// ------------------------------------------------------------------ ARCA

const productionEnv = arcaTestEnv("production")
const homologationEnv = arcaTestEnv("homologation")

function arcaDeps(env: Record<string, string | undefined>, overrides: Partial<ArcaHealthDependencies> = {}) {
  const calls: string[] = []
  const deps: ArcaHealthDependencies = {
    inspect: () => inspectArcaConfiguration(env),
    dummy: async () => { calls.push("dummy"); return { appServer: "OK", dbServer: "OK", authServer: "OK" } },
    authenticate: async () => { calls.push("wsaa"); return { expirationTime: "2026-10-28T00:00:00-03:00" } },
    pointsOfSale: async () => { calls.push("ptos"); return [{ number: 1, emissionType: "CAE", blocked: false, droppedAt: null }] },
    ...overrides,
  }
  return { deps, calls }
}

test("arca producción: configuración + FEDummy + WSAA + punto de venta -> Operativo, sin numeración ni CAE", async () => {
  const { deps, calls } = arcaDeps(productionEnv)
  const result = await checkArcaHealth(deps, liveSignal())
  assert.deepEqual(result, {
    status: "ok",
    detail: "Disponibilidad, autenticación y punto de venta 1 verificados.",
  })
  assert.deepEqual(calls, ["dummy", "wsaa", "ptos"], "no consulta último comprobante ni pide CAE")
})

test("arca homologación: todo OK pero sin validez fiscal -> Degradado", async () => {
  const result = await checkArcaHealth(arcaDeps(homologationEnv).deps, liveSignal())
  assert.equal(result.status, "warning")
  assert.match(result.detail, /^Homologación \(sin validez fiscal\)/)
})

test("arca: configuración inválida (vencido, key ajena, CUIT distinto) no contacta a ARCA", async () => {
  const expired = createArcaTestCredentials({
    issuerCn: "Computadores",
    notBefore: new Date(Date.now() - 400 * DAY_MS),
    notAfter: new Date(Date.now() - DAY_MS),
  })
  const variants: Array<[string, Record<string, string | undefined>, RegExp]> = [
    ["certificado vencido", arcaTestEnv("production", {}, expired), /venció/],
    ["key incorrecta", arcaTestEnv("production", { ARCA_PRIVATE_KEY: createTestKeyPem().privateKey }), /no corresponde al certificado/],
    ["CUIT distinto", arcaTestEnv("production", { ARCA_CUIT: TEST_CUIT.replace(/^20/, "27") }), /CUIT del certificado no coincide/],
  ]
  for (const [name, env, detail] of variants) {
    const { deps, calls } = arcaDeps(env)
    const result = await checkArcaHealth(deps, liveSignal())
    assert.equal(result.status, "error", name)
    assert.match(result.detail, detail, name)
    assert.deepEqual(calls, [], name)
    assert.doesNotMatch(result.detail, /BEGIN|PRIVATE KEY|CERTIFICATE/, name)
  }
})

test("arca: FEDummy caído, con timeout o informando problemas", async () => {
  const down = await checkArcaHealth(arcaDeps(productionEnv, { dummy: async () => { throw new Error("ECONNRESET detalle interno") } }).deps, liveSignal())
  assert.equal(down.status, "error")
  assert.match(down.detail, /no respondió a la consulta de disponibilidad/)
  assert.doesNotMatch(down.detail, /ECONNRESET/)

  const timeout = await checkArcaHealth(arcaDeps(productionEnv, { dummy: async () => { throw new Error("aborted") } }).deps, abortedSignal())
  assert.equal(timeout.status, "error")
  assert.match(timeout.detail, /no respondió a tiempo/)

  const reported = await checkArcaHealth(
    arcaDeps(productionEnv, { dummy: async () => ({ appServer: "OK", dbServer: "ERR", authServer: "OK" }) }).deps,
    liveSignal(),
  )
  assert.equal(reported.status, "warning")
  assert.match(reported.detail, /base ERR/)
})

test("arca: AuthServer=OK de FEDummy no se presenta como autenticación de BEYONIX", async () => {
  const { deps, calls } = arcaDeps(productionEnv, {
    authenticate: async () => { throw new Error("WSAA rechazó la autenticación: ns1:cms.cert.untrusted.") },
  })
  const result = await checkArcaHealth(deps, liveSignal())
  assert.equal(result.status, "error")
  assert.match(result.detail, /rechazó o no completó la autenticación de BEYONIX \(WSAA\)/)
  assert.deepEqual(calls, ["dummy"], "sin TA no hay consulta autenticada")
})

test("arca: WSAA OK pero consulta autenticada rechazada, punto de venta bloqueado o timeout", async () => {
  const rejected = await checkArcaHealth(arcaDeps(productionEnv, { pointsOfSale: async () => { throw new Error("SOAP fault") } }).deps, liveSignal())
  assert.equal(rejected.status, "error")
  assert.match(rejected.detail, /rechazó la consulta autenticada/)

  const blocked = await checkArcaHealth(
    arcaDeps(productionEnv, { pointsOfSale: async () => [{ number: 1, emissionType: "CAE", blocked: true, droppedAt: null }] }).deps,
    liveSignal(),
  )
  assert.equal(blocked.status, "error")
  assert.match(blocked.detail, /bloqueado/)

  const controller = new AbortController()
  const pending = checkArcaHealth(
    arcaDeps(productionEnv, {
      pointsOfSale: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    }).deps,
    controller.signal,
  )
  setTimeout(() => controller.abort(), 5)
  const timeout = await pending
  assert.equal(timeout.status, "unknown")
})

test("arca: el health no puede pedir CAE ni consultar numeración", () => {
  const source = readFileSync(new URL("./system-health-checks.ts", import.meta.url), "utf8")
  const route = readFileSync(new URL("../../app/api/admin/system-health/route.ts", import.meta.url), "utf8")
  for (const code of [source, route]) {
    assert.doesNotMatch(code, /fecaeSolicitar|FECAESolicitar|requestCae|processArcaInvoice|emitCreditNote|feCompUltimoAutorizado/)
  }
  assert.doesNotMatch(route, /crearOrdenEnvio|cotizarEnvio|getEtiquetas|preference|payments|refund/i)
})

// ---------------------------------------------------- Aislamiento y runner

function allDeps(overrides: Partial<SystemHealthDependencies> = {}): SystemHealthDependencies {
  return {
    now: Date.now,
    store: storeDeps(),
    mercadoPago: mercadoPago(async () => Response.json({ id: 1 })),
    andreani: { env: andreaniEnv("QA"), verify: async () => undefined },
    arca: arcaDeps(productionEnv).deps,
    ...overrides,
  }
}

test("runner: una integración que explota no rompe a las demás y no filtra la excepción", async () => {
  const run = await runSystemHealthChecks(allDeps({
    arca: {
      ...arcaDeps(productionEnv).deps,
      inspect: () => { throw new Error(`stack con ${MP_TOKEN} y /srv/beyonix/.env`) },
    },
  }))
  const byId = Object.fromEntries(run.checks.map((check) => [check.id, check]))
  assert.deepEqual(run.checks.map((check) => check.id), ["store", "mercadopago", "andreani", "arca"])
  assert.equal(byId.store.status, "ok")
  assert.equal(byId.mercadopago.status, "ok")
  assert.equal(byId.andreani.status, "ok")
  assert.equal(byId.arca.status, "unknown")
  assert.equal(byId.arca.detail, "Error interno al ejecutar la comprobación.")
  assert.ok(!JSON.stringify(run).includes(MP_TOKEN))
  assert.ok(!JSON.stringify(run).includes("/srv/beyonix"))
  for (const check of run.checks) assert.ok(Number.isFinite(Date.parse(check.checkedAt)))
})

// ----------------------------------------------------------------- Cache

test("cache: reutiliza dentro del TTL, vuelve a consultar al vencer, force con intervalo mínimo", async () => {
  let clock = 1_000_000
  const cache = createSystemHealthCache<number>({ ttlMs: 50_000, minForceIntervalMs: 10_000, now: () => clock })
  let runs = 0
  const run = async () => ++runs

  assert.deepEqual(await cache.get("k", run), { value: 1, cached: false })
  clock += 20_000
  assert.deepEqual(await cache.get("k", run), { value: 1, cached: true }, "dentro del TTL")
  assert.deepEqual(await cache.get("k", run, { force: true }), { value: 2, cached: false }, "force saltea el cache")
  clock += 5_000
  assert.deepEqual(await cache.get("k", run, { force: true }), { value: 2, cached: true }, "force repetido no golpea proveedores")
  clock += 50_000
  assert.deepEqual(await cache.get("k", run), { value: 3, cached: false }, "vencido -> nueva comprobación")
})

test("cache: requests simultáneos comparten una sola comprobación", async () => {
  const cache = createSystemHealthCache<number>()
  let runs = 0
  let release: (() => void) | undefined
  const run = () => new Promise<number>((resolve) => { runs += 1; release = () => resolve(runs) })
  const pending = [cache.get("k", run), cache.get("k", run), cache.get("k", run, { force: true })]
  release?.()
  const results = await Promise.all(pending)
  assert.equal(runs, 1)
  assert.deepEqual(results.map((result) => result.value), [1, 1, 1])
})

test("cache H: dos claves distintas en simultáneo no comparten promesa ni resultado", async () => {
  const cache = createSystemHealthCache<string>()
  const releases = new Map<string, (value: string) => void>()
  const runFor = (key: string) => () => new Promise<string>((resolve) => releases.set(key, resolve))

  const a1 = cache.get("A", runFor("A"))
  const b1 = cache.get("B", runFor("B"))
  const a2 = cache.get("A", async () => "no-debe-correr")
  assert.equal(releases.size, 2, "A y B corren por separado")

  releases.get("B")?.("resultado-B")
  releases.get("A")?.("resultado-A")
  assert.deepEqual(await a1, { value: "resultado-A", cached: false })
  assert.deepEqual(await b1, { value: "resultado-B", cached: false })
  assert.deepEqual(await a2, { value: "resultado-A", cached: false }, "A se comparte sólo con A")

  assert.deepEqual(await cache.get("A", async () => "x"), { value: "resultado-A", cached: true })
  assert.deepEqual(await cache.get("B", async () => "x"), { value: "resultado-B", cached: true }, "B no pisó a A ni viceversa")
})

test("cache: un error no queda cacheado y los ambientes no se mezclan", async () => {
  let clock = 0
  const cache = createSystemHealthCache<string>({ now: () => clock })
  await assert.rejects(() => cache.get("k", async () => { throw new Error("falló") }))
  assert.deepEqual(await cache.get("k", async () => "ok"), { value: "ok", cached: false })

  const qa = systemHealthCacheKey(["QA", "usuario"])
  const prod = systemHealthCacheKey(["PROD", "usuario"])
  assert.notEqual(qa, prod)
  assert.deepEqual(await cache.get(qa, async () => "resultado-qa"), { value: "resultado-qa", cached: false })
  assert.deepEqual(await cache.get(prod, async () => "resultado-prod"), { value: "resultado-prod", cached: false })
  clock += 1_000
  assert.deepEqual(await cache.get(qa, async () => "nuevo-qa"), { value: "resultado-qa", cached: true }, "QA conserva su propio resultado")
  assert.deepEqual(await cache.get(prod, async () => "nuevo-prod"), { value: "resultado-prod", cached: true }, "el cache de PROD no responde por QA")
  assert.ok(!systemHealthCacheKey([MP_TOKEN]).includes("token-secreto"), "la clave es un hash")
})

// ------------------------------------------------------------- Huella

function fingerprintInput(overrides: {
  env?: Partial<NodeJS.ProcessEnv>
  arcaEnv?: Record<string, string | undefined>
  publicSettingsUrl?: string | null
} = {}) {
  return {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://db.example",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-a",
      MERCADOPAGO_ACCESS_TOKEN: MP_TOKEN,
      ...andreaniEnv("PROD"),
      ...overrides.env,
    } as NodeJS.ProcessEnv,
    publicSettingsUrl: overrides.publicSettingsUrl === undefined ? SETTINGS_URL : overrides.publicSettingsUrl,
    arca: inspectArcaConfiguration(overrides.arcaEnv ?? productionEnv),
  }
}

test("huella F/G: cambia con token MP, credenciales Andreani, material ARCA y URL; nunca contiene secretos", () => {
  const base = systemHealthFingerprint(fingerprintInput())
  assert.equal(systemHealthFingerprint(fingerprintInput()), base, "misma configuración, misma clave")

  const rotatedArca = createArcaTestCredentials({ issuerCn: "Computadores" })
  const variants: Array<[string, ReturnType<typeof fingerprintInput>]> = [
    ["G: token MP", fingerprintInput({ env: { MERCADOPAGO_ACCESS_TOKEN: `${MP_TOKEN}-rotado` } })],
    ["E: password Andreani", fingerprintInput({ env: { ANDREANI_PROD_PASSWORD: "otra-clave" } })],
    ["usuario Andreani", fingerprintInput({ env: { ANDREANI_PROD_USERNAME: "otro-usuario" } })],
    ["URL Andreani", fingerprintInput({ env: { ANDREANI_PROD_API_URL: "https://apis.andreani.com/" } })],
    ["ambiente Andreani", fingerprintInput({ env: { ANDREANI_ENV: "QA" } })],
    ["F: certificado y clave ARCA", fingerprintInput({ arcaEnv: arcaTestEnv("production", {}, rotatedArca) })],
    ["F: sólo la clave ARCA (inválida)", fingerprintInput({ arcaEnv: { ...productionEnv, ARCA_PRIVATE_KEY: createTestKeyPem().privateKey } })],
    ["punto de venta ARCA", fingerprintInput({ arcaEnv: { ...productionEnv, ARCA_PTO_VTA: "2" } })],
    ["ambiente ARCA", fingerprintInput({ arcaEnv: homologationEnv })],
    ["URL pública", fingerprintInput({ publicSettingsUrl: "https://otra.example/api/store/settings" })],
    ["service role", fingerprintInput({ env: { SUPABASE_SERVICE_ROLE_KEY: "service-role-b" } })],
  ]
  for (const [name, input] of variants) {
    const key = systemHealthFingerprint(input)
    assert.notEqual(key, base, name)
    assert.match(key, /^[0-9a-f]{64}$/, `${name}: huella opaca`)
  }
  for (const secret of [MP_TOKEN, "clave-prod-health", "usuario-prod-health", "service-role-a"]) {
    assert.ok(!base.includes(secret))
  }
})

// ------------------------------------------------------------- Textos

test("I: los textos de 'Operativo' describen sólo lo comprobado", async () => {
  resetAndreaniRuntimeStateForTests()
  const run = await runSystemHealthChecks(allDeps({
    andreani: andreaniDeps(andreaniEnv("PROD"), loginOk).deps,
  }))
  const details = Object.fromEntries(run.checks.map((check) => [check.id, check]))
  assert.deepEqual(
    Object.fromEntries(run.checks.map((check) => [check.id, [check.status, check.detail]])),
    {
      store: ["ok", "API pública y base de datos respondieron correctamente."],
      mercadopago: ["ok", "API y autenticación de la cuenta verificadas correctamente."],
      andreani: ["ok", "Login y credenciales verificadas correctamente (PROD)."],
      arca: ["ok", "Disponibilidad, autenticación y punto de venta 1 verificados."],
    },
  )
  for (const check of Object.values(details)) {
    assert.doesNotMatch(
      check.detail,
      /listo|lista|cobrar|pagos|webhook|contrato|sucursal|envío|tarifa|emitir|factura|CAE|numeración/i,
      check.id,
    )
  }
})
