/**
 * Contrato y estado del panel "Estado de integraciones" (Admin > Dashboard).
 * Sin React ni red: lo comparten el endpoint, el hook y los tests.
 *
 * - `checkedAt` de cada integración es la hora real en que el servidor obtuvo
 *   ESE resultado. El cliente nunca lo inventa.
 * - `status: "unknown"` = no se pudo determinar (error interno, tiempo
 *   agotado del propio check). No es un resultado del proveedor.
 * - Un fallo del endpoint completo, o un "unknown" nuevo, no borra el último
 *   resultado válido: se conserva marcado como "último intento falló". Un
 *   resultado explícito del proveedor (incluido un error) siempre reemplaza.
 * - Todo resultado vence a los SYSTEM_HEALTH_STALE_AFTER_MS de su checkedAt,
 *   medido contra el reloj actual (no contra el último intento): una pestaña
 *   suspendida o un equipo que despierta no muestran un "Operativo" viejo.
 */

export type IntegrationId = "store" | "mercadopago" | "andreani" | "arca"

export type IntegrationHealthStatus = "ok" | "warning" | "error" | "disabled" | "unknown"

export interface IntegrationHealth {
  id: IntegrationId
  label: string
  status: IntegrationHealthStatus
  detail: string
  checkedAt: string
  latencyMs: number | null
}

export interface SystemHealthResponse {
  checks: IntegrationHealth[]
  /** Hora en que se produjo este conjunto de resultados (no la de la respuesta). */
  checkedAt: string
  /** true si el servidor devolvió un resultado reciente sin volver a consultar. */
  cached: boolean
  pollAfterMs: number
}

export const SYSTEM_HEALTH_POLL_MS = 60_000
export const SYSTEM_HEALTH_STALE_AFTER_MS = 5 * 60_000

export const INTEGRATION_LABELS: Record<IntegrationId, string> = {
  store: "Tienda y base de datos",
  mercadopago: "Mercado Pago",
  andreani: "Andreani",
  arca: "ARCA / Facturación electrónica",
}

export const INTEGRATION_ORDER: readonly IntegrationId[] = ["store", "mercadopago", "andreani", "arca"]

export interface IntegrationHealthEntry {
  /** Último resultado válido de esta integración (null: nunca hubo uno). */
  result: IntegrationHealth | null
  /** El intento más reciente no produjo un resultado válido para esta integración. */
  lastAttemptFailed: boolean
}

export interface SystemHealthState {
  entries: Record<IntegrationId, IntegrationHealthEntry>
  /** Hubo al menos una respuesta del endpoint (válida o no). */
  attempted: boolean
  lastAttemptAt: string | null
  /** Última vez que el panel recibió una respuesta válida del endpoint. */
  lastUpdatedAt: string | null
  /** Fallo del endpoint completo en el último intento (mensaje seguro). */
  lastAttemptError: string | null
}

export function createInitialSystemHealthState(): SystemHealthState {
  return {
    entries: {
      store: { result: null, lastAttemptFailed: false },
      mercadopago: { result: null, lastAttemptFailed: false },
      andreani: { result: null, lastAttemptFailed: false },
      arca: { result: null, lastAttemptFailed: false },
    },
    attempted: false,
    lastAttemptAt: null,
    lastUpdatedAt: null,
    lastAttemptError: null,
  }
}

function isIntegrationId(value: unknown): value is IntegrationId {
  return typeof value === "string" && (INTEGRATION_ORDER as readonly string[]).includes(value)
}

const STATUSES: readonly IntegrationHealthStatus[] = ["ok", "warning", "error", "disabled", "unknown"]

/** Valida la respuesta del endpoint; descarta entradas con forma inválida. */
export function parseSystemHealthResponse(value: unknown): SystemHealthResponse | null {
  if (!value || typeof value !== "object" || !("checks" in value) || !Array.isArray(value.checks)) {
    return null
  }
  const record = value as Record<string, unknown>
  const checks = (value.checks as unknown[]).flatMap((item): IntegrationHealth[] => {
    if (!item || typeof item !== "object") return []
    const check = item as Record<string, unknown>
    if (
      !isIntegrationId(check.id) ||
      typeof check.status !== "string" ||
      !(STATUSES as readonly string[]).includes(check.status) ||
      typeof check.detail !== "string" ||
      typeof check.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(check.checkedAt))
    ) {
      return []
    }
    return [{
      id: check.id,
      label: INTEGRATION_LABELS[check.id],
      status: check.status as IntegrationHealthStatus,
      detail: check.detail,
      checkedAt: check.checkedAt,
      latencyMs: typeof check.latencyMs === "number" && Number.isFinite(check.latencyMs) ? check.latencyMs : null,
    }]
  })

  return {
    checks,
    checkedAt: typeof record.checkedAt === "string" ? record.checkedAt : new Date(0).toISOString(),
    cached: record.cached === true,
    pollAfterMs:
      typeof record.pollAfterMs === "number" && record.pollAfterMs >= SYSTEM_HEALTH_POLL_MS
        ? record.pollAfterMs
        : SYSTEM_HEALTH_POLL_MS,
  }
}

function isNewer(candidate: IntegrationHealth, current: IntegrationHealth | null) {
  return !current || Date.parse(candidate.checkedAt) >= Date.parse(current.checkedAt)
}

export function applySystemHealthResponse(
  state: SystemHealthState,
  response: SystemHealthResponse,
  attemptedAt: string,
): SystemHealthState {
  const entries = { ...state.entries }
  const byId = new Map(response.checks.map((check) => [check.id, check]))

  for (const id of INTEGRATION_ORDER) {
    const previous = entries[id]
    const next = byId.get(id)
    if (!next || next.status === "unknown") {
      // Sin resultado determinable: se conserva el último válido (si existe).
      entries[id] = previous.result && previous.result.status !== "unknown"
        ? { result: previous.result, lastAttemptFailed: true }
        : { result: next ?? previous.result, lastAttemptFailed: !next }
      continue
    }
    // Un resultado más viejo que el que ya se muestra (respuesta tardía) no lo pisa.
    entries[id] = isNewer(next, previous.result)
      ? { result: next, lastAttemptFailed: false }
      : previous
  }

  return { entries, attempted: true, lastAttemptAt: attemptedAt, lastUpdatedAt: attemptedAt, lastAttemptError: null }
}

export function applySystemHealthFailure(
  state: SystemHealthState,
  message: string,
  attemptedAt: string,
): SystemHealthState {
  const entries = { ...state.entries }
  for (const id of INTEGRATION_ORDER) {
    entries[id] = { result: entries[id].result, lastAttemptFailed: true }
  }
  return { ...state, entries, attempted: true, lastAttemptAt: attemptedAt, lastAttemptError: message }
}

export interface IntegrationHealthView {
  id: IntegrationId
  label: string
  /** Estado que se muestra (un resultado vencido o inexistente se muestra "unknown"). */
  status: IntegrationHealthStatus | "pending"
  badge: string
  detail: string
  checkedAt: string | null
  latencyMs: number | null
  lastAttemptFailed: boolean
  expired: boolean
}

export function isIntegrationHealthExpired(result: Pick<IntegrationHealth, "checkedAt">, nowMs: number) {
  const checkedAtMs = Date.parse(result.checkedAt)
  return !Number.isFinite(checkedAtMs) || nowMs - checkedAtMs > SYSTEM_HEALTH_STALE_AFTER_MS
}

const BADGES: Record<IntegrationHealthStatus | "pending", string> = {
  pending: "Verificando",
  ok: "Operativo",
  warning: "Degradado",
  error: "Caído",
  disabled: "Deshabilitado",
  unknown: "No verificable",
}

/**
 * `nowMs` es el reloj actual (Date.now() de quien presenta): un resultado
 * vence por su propio checkedAt aunque no haya habido otro intento.
 */
export function presentIntegrationHealth(
  id: IntegrationId,
  state: SystemHealthState,
  nowMs: number,
): IntegrationHealthView {
  const { result, lastAttemptFailed } = state.entries[id]
  const base = { id, label: INTEGRATION_LABELS[id], lastAttemptFailed }

  if (!result) {
    const failed = state.attempted
    return {
      ...base,
      status: failed ? "unknown" : "pending",
      badge: failed ? BADGES.unknown : BADGES.pending,
      detail: failed ? "No se pudo completar la comprobación." : "Ejecutando una comprobación real...",
      checkedAt: null,
      latencyMs: null,
      expired: false,
    }
  }

  const expired = isIntegrationHealthExpired(result, nowMs)
  const status = expired ? "unknown" : result.status
  return {
    ...base,
    status,
    badge: BADGES[status],
    detail: expired
      ? "Sin una comprobación válida en los últimos 5 minutos."
      : result.detail,
    checkedAt: result.checkedAt,
    latencyMs: result.latencyMs,
    expired,
  }
}
