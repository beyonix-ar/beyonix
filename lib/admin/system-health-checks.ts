import "server-only"

import { createHmac, randomBytes } from "node:crypto"

import {
  getAndreaniConfigurationStatus,
  normalizeAndreaniError,
} from "../andreani/client.ts"
import type { ArcaConfiguration, ArcaConfigurationStatus } from "../arca/configuration.ts"
import { runArcaConnectivityDiagnostics, type DiagnosticPointOfSale } from "../arca/production-diagnostics.ts"
import {
  INTEGRATION_LABELS,
  type IntegrationHealth,
  type IntegrationHealthStatus,
  type IntegrationId,
} from "./system-health.ts"

/**
 * Comprobaciones READ-ONLY de "Estado de integraciones". Ninguna crea,
 * cotiza, cobra, emite ni modifica nada:
 *
 * - Tienda: una lectura liviana de la base + GET /api/store/settings.
 * - Mercado Pago: GET /users/me (token y API). No crea preferencias ni pagos.
 * - Andreani: GET /login real (no el token cacheado). No tarifa ni envía.
 * - ARCA: configuración local -> FEDummy -> WSAA -> FEParamGetPtosVenta
 *   (consulta autenticada). Nunca solicita CAE.
 *
 * Cada check tiene su propio presupuesto de tiempo con AbortSignal; un check
 * que falla o se cuelga no afecta a los demás. Los detalles son textos
 * propios: nunca se reenvían cuerpos, headers ni mensajes del proveedor.
 */

export const HEALTH_BUDGET_MS: Record<IntegrationId, number> = {
  store: 5_000,
  mercadopago: 5_000,
  andreani: 6_000,
  arca: 8_000,
}

/** Margen tras el presupuesto: sólo actúa si un check ignora su AbortSignal. */
const SAFETY_NET_MS = 500

const MERCADOPAGO_USERS_ME_URL = "https://api.mercadopago.com/users/me"

export interface StoreHealthDependencies {
  /** Lectura liviana real; devuelve el `error` de Supabase (null = OK). */
  readDatabase(signal: AbortSignal): PromiseLike<{ error: unknown }>
  /** URL absoluta de /api/store/settings, o null si la URL pública no es confiable. */
  publicSettingsUrl: string | null
  fetch: typeof fetch
}

export interface ArcaHealthDependencies {
  inspect(): { status: ArcaConfigurationStatus; configuration: ArcaConfiguration | null }
  dummy(signal: AbortSignal): Promise<{ appServer: string; dbServer: string; authServer: string }>
  authenticate(configuration: ArcaConfiguration): Promise<{ expirationTime: string }>
  pointsOfSale(signal: AbortSignal): Promise<DiagnosticPointOfSale[]>
}

export interface SystemHealthDependencies {
  now: () => number
  store: StoreHealthDependencies
  mercadoPago: { accessToken: string | undefined; fetch: typeof fetch }
  andreani: {
    env: NodeJS.ProcessEnv
    /** GET /login real con el timeout indicado; lanza AndreaniError. */
    verify(timeoutMs: number): Promise<void>
  }
  arca: ArcaHealthDependencies
}

type CheckResult = Pick<IntegrationHealth, "status" | "detail">

type DatabaseOutcome = "ok" | "timeout" | "error"

function isAbort(signal: AbortSignal) {
  return signal.aborted
}

function seconds(ms: number) {
  return `${Math.round(ms / 1000)} s`
}

// ---------------------------------------------------------------- Tienda

type PublicApiOutcome =
  | { kind: "ok"; source: "database" | "fallback" | "unknown" }
  | { kind: "unconfigured" }
  | { kind: "http"; status: number }
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "invalid" }

async function probePublicApi(
  deps: StoreHealthDependencies,
  signal: AbortSignal,
): Promise<PublicApiOutcome> {
  if (!deps.publicSettingsUrl) return { kind: "unconfigured" }
  try {
    const response = await deps.fetch(deps.publicSettingsUrl, {
      cache: "no-store",
      headers: { "x-health-check": "dashboard" },
      redirect: "error",
      signal,
    })
    if (!response.ok) return { kind: "http", status: response.status }
    const body: unknown = await response.json().catch(() => null)
    if (!body || typeof body !== "object" || !("settings" in body) || !body.settings || typeof body.settings !== "object") {
      return { kind: "invalid" }
    }
    const source = response.headers.get("x-settings-source")
    return { kind: "ok", source: source === "database" || source === "fallback" ? source : "unknown" }
  } catch {
    return isAbort(signal) ? { kind: "timeout" } : { kind: "network" }
  }
}

export async function checkStoreHealth(
  deps: StoreHealthDependencies,
  signal: AbortSignal,
): Promise<CheckResult> {
  const [database, publicApi] = await Promise.all([
    Promise.resolve()
      .then(() => deps.readDatabase(signal))
      .then<DatabaseOutcome, DatabaseOutcome>(
        ({ error }) => (error ? (isAbort(signal) ? "timeout" : "error") : "ok"),
        () => (isAbort(signal) ? "timeout" : "error"),
      ),
    probePublicApi(deps, signal),
  ])

  if (database !== "ok") {
    return {
      status: "error",
      detail: database === "timeout"
        ? "La base de datos no respondió a tiempo."
        : "La base de datos no respondió correctamente.",
    }
  }

  switch (publicApi.kind) {
    case "unconfigured":
      return {
        status: "warning",
        detail: "Base de datos OK. La URL pública del sitio no está configurada: no se verificó la API pública.",
      }
    case "http":
      return { status: "error", detail: `La API pública respondió HTTP ${publicApi.status}.` }
    case "timeout":
      return { status: "error", detail: "La API pública no respondió a tiempo." }
    case "network":
      return { status: "error", detail: "No se pudo conectar con la API pública." }
    case "invalid":
      return { status: "error", detail: "La API pública devolvió una respuesta inválida." }
    case "ok":
      // Sólo "database" confirma que la API leyó la configuración real.
      switch (publicApi.source) {
        case "database":
          return { status: "ok", detail: "API pública y base de datos respondieron correctamente." }
        case "fallback":
          return {
            status: "warning",
            detail: "La API pública respondió con valores de respaldo: no pudo leer la configuración de la tienda.",
          }
        case "unknown":
          return {
            status: "warning",
            detail: "La API pública respondió, pero no informó el origen de la configuración.",
          }
      }
  }
}

// ---------------------------------------------------------- Mercado Pago

function hasMercadoPagoIdentity(body: unknown) {
  if (!body || typeof body !== "object" || !("id" in body)) return false
  const id = body.id
  return (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
    (typeof id === "string" && /^\d{1,20}$/.test(id))
}

export async function checkMercadoPagoHealth(
  deps: SystemHealthDependencies["mercadoPago"],
  signal: AbortSignal,
): Promise<CheckResult> {
  const token = deps.accessToken?.trim()
  if (!token) {
    return { status: "disabled", detail: "No hay credenciales configuradas." }
  }

  let response: Response
  try {
    response = await deps.fetch(MERCADOPAGO_USERS_ME_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal,
    })
  } catch {
    return isAbort(signal)
      ? { status: "error", detail: `Mercado Pago no respondió en ${seconds(HEALTH_BUDGET_MS.mercadopago)}.` }
      : { status: "error", detail: "No se pudo conectar con Mercado Pago." }
  }

  if (response.status === 401 || response.status === 403) {
    return {
      status: "error",
      detail: `Mercado Pago rechazó las credenciales (HTTP ${response.status}).`,
    }
  }
  if (response.status === 429) {
    return {
      status: "warning",
      detail: "Mercado Pago limitó temporalmente las consultas (HTTP 429).",
    }
  }
  if (response.status >= 500) {
    return {
      status: "error",
      detail: `Mercado Pago no está disponible (HTTP ${response.status}).`,
    }
  }
  if (!response.ok) {
    return { status: "error", detail: `Mercado Pago respondió HTTP ${response.status}.` }
  }

  const body: unknown = await response.json().catch(() => null)
  if (!hasMercadoPagoIdentity(body)) {
    return {
      status: "warning",
      detail: "Mercado Pago respondió con un formato inesperado.",
    }
  }

  // Los Access Token "TEST-" son de sandbox: autentican pero no cobran real.
  return token.startsWith("TEST-")
    ? {
        status: "warning",
        detail: "API y autenticación verificadas, pero son credenciales de prueba (sandbox).",
      }
    : { status: "ok", detail: "API y autenticación de la cuenta verificadas correctamente." }
}

// -------------------------------------------------------------- Andreani

export async function checkAndreaniHealth(
  deps: SystemHealthDependencies["andreani"],
): Promise<CheckResult> {
  if (!deps.env.ANDREANI_ENV?.trim()) {
    return { status: "disabled", detail: "Andreani no está configurado." }
  }

  // Validez de la configuración, sin el guard de operaciones PROD.
  const configuration = getAndreaniConfigurationStatus(deps.env)
  if (!configuration.configured) {
    return { status: "error", detail: `Configuración inválida: ${configuration.message}` }
  }

  try {
    await deps.verify(HEALTH_BUDGET_MS.andreani)
    return {
      status: "ok",
      detail: `Login y credenciales verificadas correctamente (${configuration.environment}).`,
    }
  } catch (error) {
    const safeError = normalizeAndreaniError(error, deps.env)
    switch (safeError.code) {
      case "AUTHENTICATION_FAILED":
        return { status: "error", detail: "Andreani rechazó las credenciales." }
      case "TIMEOUT":
        return {
          status: "error",
          detail: `Andreani no respondió en ${seconds(HEALTH_BUDGET_MS.andreani)}.`,
        }
      case "SERVICE_UNAVAILABLE":
        return {
          status: "error",
          detail: safeError.status
            ? `Andreani no está disponible (HTTP ${safeError.status}).`
            : "No se pudo conectar con Andreani.",
        }
      case "INVALID_RESPONSE":
        return { status: "warning", detail: "Andreani respondió sin un token válido." }
      case "REQUEST_FAILED":
        return {
          status: "error",
          detail: safeError.status
            ? `Andreani rechazó la verificación (HTTP ${safeError.status}).`
            : "No se pudo completar la verificación con Andreani.",
        }
      default:
        return { status: "unknown", detail: "No se pudo verificar Andreani de forma segura." }
    }
  }
}

// ------------------------------------------------------------------ ARCA

type ArcaFailure = "timeout" | "error"

/** Corta la espera si vence la señal (la operación compartida sigue sola). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new Error("aborted"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

export async function checkArcaHealth(
  deps: ArcaHealthDependencies,
  signal: AbortSignal,
): Promise<CheckResult> {
  const failures = new Map<"fedummy" | "wsaa" | "points_of_sale", ArcaFailure>()
  const track = <T>(step: "fedummy" | "wsaa" | "points_of_sale", run: () => Promise<T>) =>
    run().catch((error: unknown) => {
      failures.set(step, isAbort(signal) ? "timeout" : "error")
      throw error
    })

  const report = await runArcaConnectivityDiagnostics(
    {
      inspect: deps.inspect,
      dummy: () => track("fedummy", () => deps.dummy(signal)),
      // WSAA es compartido con la emisión (deduplicado y persistido): no se
      // aborta, sólo se deja de esperar. Normalmente sale del TA vigente.
      authenticate: (configuration) =>
        track("wsaa", () => untilAborted(deps.authenticate(configuration), signal)),
      pointsOfSale: () => track("points_of_sale", () => deps.pointsOfSale(signal)),
      lastAuthorized: () => Promise.reject(new Error("El health check no consulta numeración.")),
      describeError: () => "",
    },
    { through: "points_of_sale" },
  )

  const step = (id: string) => report.steps.find((candidate) => candidate.id === id)
  const configuration = step("configuration")
  if (!configuration?.ok) {
    return {
      status: "error",
      detail: `Configuración inválida: ${configuration?.detail || "no se pudo leer."}`,
    }
  }

  const dummy = step("fedummy")
  if (!dummy?.ok) {
    const failure = failures.get("fedummy")
    return failure
      ? {
          status: "error",
          detail: failure === "timeout"
            ? "ARCA no respondió a tiempo a la consulta de disponibilidad (FEDummy)."
            : "ARCA no respondió a la consulta de disponibilidad (FEDummy).",
        }
      : {
          status: "warning",
          detail: `ARCA informa servicios con problemas. ${dummy?.detail ?? ""}`.trim(),
        }
  }

  if (!step("wsaa")?.ok) {
    return failures.get("wsaa") === "timeout"
      ? {
          status: "unknown",
          detail: "ARCA está disponible, pero la autenticación (WSAA) no terminó a tiempo.",
        }
      : {
          status: "error",
          detail: "ARCA está disponible, pero rechazó o no completó la autenticación de BEYONIX (WSAA).",
        }
  }

  const pointsOfSale = step("points_of_sale")
  if (!pointsOfSale?.ok) {
    const failure = failures.get("points_of_sale")
    if (failure === "timeout") {
      return {
        status: "unknown",
        detail: "ARCA no respondió a tiempo a la consulta autenticada de puntos de venta.",
      }
    }
    return {
      status: "error",
      detail: failure
        ? "ARCA rechazó la consulta autenticada de puntos de venta."
        : pointsOfSale?.detail ?? "El punto de venta no está habilitado.",
    }
  }

  return report.environment === "production"
    ? {
        status: "ok",
        detail: `Disponibilidad, autenticación y punto de venta ${report.pointOfSale} verificados.`,
      }
    : {
        status: "warning",
        detail: "Homologación (sin validez fiscal): disponibilidad, autenticación y punto de venta verificados.",
      }
}

// ---------------------------------------------------------------- Runner

function unknownCheck(detail: string): CheckResult {
  return { status: "unknown", detail }
}

async function runGuarded(
  id: IntegrationId,
  run: (signal: AbortSignal) => Promise<CheckResult>,
  now: () => number,
): Promise<IntegrationHealth> {
  const startedAt = now()
  const budget = HEALTH_BUDGET_MS[id]
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), budget)
  let safetyTimer: ReturnType<typeof setTimeout> | undefined

  let result: CheckResult
  try {
    result = await Promise.race([
      run(controller.signal),
      new Promise<CheckResult>((resolve) => {
        safetyTimer = setTimeout(
          () => resolve(unknownCheck("La comprobación superó el tiempo límite.")),
          budget + SAFETY_NET_MS,
        )
      }),
    ])
  } catch (error) {
    console.warn("SYSTEM_HEALTH_CHECK_FAILED", {
      integration: id,
      error: error instanceof Error ? error.name : typeof error,
    })
    result = unknownCheck("Error interno al ejecutar la comprobación.")
  } finally {
    clearTimeout(abortTimer)
    if (safetyTimer) clearTimeout(safetyTimer)
  }

  const finishedAt = now()
  const status: IntegrationHealthStatus = result.status
  return {
    id,
    label: INTEGRATION_LABELS[id],
    status,
    detail: result.detail,
    checkedAt: new Date(finishedAt).toISOString(),
    latencyMs: status === "disabled" ? null : Math.max(0, Math.round(finishedAt - startedAt)),
  }
}

export interface SystemHealthRun {
  checks: IntegrationHealth[]
  checkedAt: string
}

export async function runSystemHealthChecks(deps: SystemHealthDependencies): Promise<SystemHealthRun> {
  const tasks: Array<[IntegrationId, (signal: AbortSignal) => Promise<CheckResult>]> = [
    ["store", (signal) => checkStoreHealth(deps.store, signal)],
    ["mercadopago", (signal) => checkMercadoPagoHealth(deps.mercadoPago, signal)],
    ["andreani", () => checkAndreaniHealth(deps.andreani)],
    ["arca", (signal) => checkArcaHealth(deps.arca, signal)],
  ]
  const checks = await Promise.all(tasks.map(([id, run]) => runGuarded(id, run, deps.now)))
  return { checks, checkedAt: new Date(deps.now()).toISOString() }
}

// ----------------------------------------------------------------- Cache

export interface SystemHealthCacheOptions {
  /** Vida de un resultado: varias pestañas/admins comparten una comprobación. */
  ttlMs?: number
  /** "Comprobar ahora" no vuelve a consultar proveedores más seguido que esto. */
  minForceIntervalMs?: number
  now?: () => number
}

export const SYSTEM_HEALTH_CACHE_TTL_MS = 50_000
export const SYSTEM_HEALTH_MIN_FORCE_INTERVAL_MS = 10_000

export function createSystemHealthCache<T>({
  ttlMs = SYSTEM_HEALTH_CACHE_TTL_MS,
  minForceIntervalMs = SYSTEM_HEALTH_MIN_FORCE_INTERVAL_MS,
  now = Date.now,
}: SystemHealthCacheOptions = {}) {
  // Por clave: dos configuraciones distintas nunca comparten resultado ni promesa.
  const entries = new Map<string, { value: T; storedAt: number }>()
  const inFlight = new Map<string, Promise<T>>()

  const pruneExpired = (at: number) => {
    for (const [key, entry] of entries) {
      if (at - entry.storedAt >= ttlMs) entries.delete(key)
    }
  }

  return {
    async get(
      key: string,
      run: () => Promise<T>,
      { force = false }: { force?: boolean } = {},
    ): Promise<{ value: T; cached: boolean }> {
      // Una comprobación en curso ya es "actual": se comparte, aun con force.
      const pending = inFlight.get(key)
      if (pending) return { value: await pending, cached: false }

      const entry = entries.get(key)
      if (entry) {
        const age = now() - entry.storedAt
        if (age < ttlMs && (!force || age < minForceIntervalMs)) {
          return { value: entry.value, cached: true }
        }
      }

      const promise = run()
      inFlight.set(key, promise)
      try {
        const value = await promise
        const storedAt = now()
        pruneExpired(storedAt)
        entries.set(key, { value, storedAt })
        return { value, cached: false }
      } finally {
        if (inFlight.get(key) === promise) inFlight.delete(key)
      }
    },
    clear() {
      entries.clear()
      inFlight.clear()
    },
  }
}

// Clave HMAC aleatoria por proceso: la huella no sirve para probar
// credenciales candidatas offline ni se puede comparar entre procesos.
const FINGERPRINT_KEY = randomBytes(32)

/** Huella opaca (HMAC-SHA256) de una lista de valores; nunca los guarda en claro. */
export function systemHealthCacheKey(parts: Array<string | number | boolean | null | undefined>) {
  return createHmac("sha256", FINGERPRINT_KEY)
    .update(JSON.stringify(parts.map((part) => part ?? null)))
    .digest("hex")
}

export interface SystemHealthFingerprintInput {
  env: NodeJS.ProcessEnv
  publicSettingsUrl: string | null
  arca: { status: ArcaConfigurationStatus; configuration: ArcaConfiguration | null }
}

/**
 * Todo lo que puede cambiar el resultado de algún check. Si cambia cualquier
 * valor (incluida una contraseña, el token o el par certificado/clave), la
 * clave cambia y no se reutiliza un resultado de la configuración anterior.
 */
export function systemHealthFingerprint({ env, publicSettingsUrl, arca }: SystemHealthFingerprintInput) {
  const { status, configuration } = arca
  return systemHealthCacheKey([
    "store", publicSettingsUrl, env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
    "mercadopago", env.MERCADOPAGO_ACCESS_TOKEN,
    "andreani", env.ANDREANI_ENV,
    env.ANDREANI_QA_API_URL, env.ANDREANI_QA_USERNAME, env.ANDREANI_QA_PASSWORD,
    env.ANDREANI_PROD_API_URL, env.ANDREANI_PROD_USERNAME, env.ANDREANI_PROD_PASSWORD,
    // Con configuración válida, el material completo; si es inválida, el estado
    // inspeccionado (vencimiento, tipo, coincidencias y errores) la distingue.
    "arca", status.environment, status.pointOfSale, status.certificateType, status.certificateExpiresAt,
    status.cuitMatches, status.privateKeyMatches, status.errors.join("|"),
    configuration?.cuit, configuration?.certificatePem, configuration?.privateKeyPem,
    configuration?.privateKeyPassphrase,
  ])
}

export const systemHealthCache = createSystemHealthCache<SystemHealthRun>()
