import { INSTALLMENT_COUNTS, type InstallmentCount } from "../products/installments.ts"

/**
 * ¿Qué cuotas puede ofrecer BEYONIX realmente SIN INTERÉS para ESTE monto?
 *
 * Fuente de verdad: Mercado Pago (`GET /v1/payment_methods/installments`).
 * Una cuota es "sin interés" sólo si Mercado Pago la informa con
 * `interest_deduction_by_collector` (el vendedor absorbe la financiación) y
 * tasa 0 para el comprador. Nada de umbrales fijos: si Mercado Pago cambia
 * los montos mínimos, esto lo refleja solo.
 *
 * Distinto de los costos observados (lib/mercadopago/observed-costs.ts), que
 * responden cuánto le cuesta Mercado Pago a BEYONIX.
 *
 * Criterio conservador: se consultan Visa y Mastercard; una cuota califica si
 * al menos un banco la ofrece y TODOS los que la ofrecen la marcan sin
 * interés. Ante cualquier duda (timeout, error, respuesta inválida) no se
 * confirma ninguna cuota: nunca se promete "sin interés" sin confirmación.
 */

export const INTEREST_FREE_REFERENCE_PAYMENT_METHODS = ["visa", "master"] as const
export const INTEREST_FREE_CACHE_TTL_MS = 10 * 60 * 1000
export const INTEREST_FREE_ERROR_CACHE_TTL_MS = 60 * 1000
export const INTEREST_FREE_REQUEST_TIMEOUT_MS = 4_000
export const INTEREST_FREE_MAX_AMOUNT = 15_000_000
const MAX_CACHE_ENTRIES = 2_000
/** Consultas nuevas a Mercado Pago por minuto y por instancia (lo cacheado no cuenta). */
const MAX_LOOKUPS_PER_MINUTE = 240
const LOOKUP_WINDOW_MS = 60 * 1000

export type InterestFreeInstallmentsResult =
  | { status: "confirmed"; counts: InstallmentCount[] }
  | { status: "unavailable" }

const INTEREST_FREE_LABEL = "interest_deduction_by_collector"

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Cuotas sin interés confirmadas a partir de las respuestas crudas de
 * Mercado Pago (una por medio de referencia). `null` si alguna respuesta no
 * tiene el formato esperado: sin datos confiables, nada se confirma.
 */
export function parseInterestFreeInstallmentCounts(responses: unknown[]): InstallmentCount[] | null {
  // Todas las cuotas > 1 que ofrece Mercado Pago (no sólo 2/3/6): con un
  // máximo N en la preferencia, el comprador puede elegir cualquier cuota
  // menor que Mercado Pago ofrezca.
  const offered = new Map<number, { free: number; paid: number }>()

  for (const response of responses) {
    if (!Array.isArray(response)) return null
    for (const issuerValue of response) {
      const issuer = asRecord(issuerValue)
      if (!issuer || !Array.isArray(issuer.payer_costs)) return null
      for (const costValue of issuer.payer_costs) {
        const cost = asRecord(costValue)
        const count = Number(cost?.installments)
        if (!cost || !Number.isInteger(count) || count <= 1) continue
        const labels = Array.isArray(cost.labels) ? cost.labels : []
        const free = Number(cost.installment_rate) === 0 && labels.includes(INTEREST_FREE_LABEL)
        const entry = offered.get(count) ?? { free: 0, paid: 0 }
        entry[free ? "free" : "paid"] += 1
        offered.set(count, entry)
      }
    }
  }

  const isFree = (count: number) => {
    const entry = offered.get(count)
    return entry !== undefined && entry.free > 0 && entry.paid === 0
  }

  return INSTALLMENT_COUNTS.filter(
    (count) =>
      isFree(count) &&
      [...offered.keys()].every((other) => other >= count || isFree(other)),
  )
}

/** Monto válido para consultar (centavos exactos) o null. */
export function normalizeInstallmentsAmount(value: unknown): number | null {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").trim())
  if (!Number.isFinite(amount) || amount <= 0 || amount > INTEREST_FREE_MAX_AMOUNT) return null
  return Math.round(amount * 100) / 100
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

interface Dependencies {
  fetch?: Fetcher
  accessToken?: string | null
  now?: () => number
}

const cache = new Map<number, { expiresAt: number; result: InterestFreeInstallmentsResult }>()
const inFlight = new Map<number, Promise<InterestFreeInstallmentsResult>>()
let lookupWindow = { startedAt: 0, count: 0 }

export function clearInterestFreeInstallmentsCache() {
  cache.clear()
  inFlight.clear()
  lookupWindow = { startedAt: 0, count: 0 }
}

function remember(amount: number, result: InterestFreeInstallmentsResult, now: number) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  const ttl = result.status === "confirmed" ? INTEREST_FREE_CACHE_TTL_MS : INTEREST_FREE_ERROR_CACHE_TTL_MS
  cache.set(amount, { expiresAt: now + ttl, result })
}

function takeLookupBudget(now: number) {
  if (now - lookupWindow.startedAt >= LOOKUP_WINDOW_MS) lookupWindow = { startedAt: now, count: 0 }
  if (lookupWindow.count >= MAX_LOOKUPS_PER_MINUTE) return false
  lookupWindow.count += 1
  return true
}

async function lookup(amount: number, dependencies: Dependencies): Promise<InterestFreeInstallmentsResult> {
  const accessToken = dependencies.accessToken ?? process.env.MERCADOPAGO_ACCESS_TOKEN
  if (!accessToken) return { status: "unavailable" }
  const fetcher: Fetcher = dependencies.fetch ?? fetch

  try {
    const responses = await Promise.all(
      INTEREST_FREE_REFERENCE_PAYMENT_METHODS.map(async (method) => {
        const url = `https://api.mercadopago.com/v1/payment_methods/installments?amount=${amount}&payment_method_id=${method}`
        const response = await fetcher(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(INTEREST_FREE_REQUEST_TIMEOUT_MS),
          cache: "no-store",
        })
        if (!response.ok) throw new Error(`MERCADOPAGO_INSTALLMENTS_${response.status}`)
        return (await response.json()) as unknown
      }),
    )
    const counts = parseInterestFreeInstallmentCounts(responses)
    return counts ? { status: "confirmed", counts } : { status: "unavailable" }
  } catch (error) {
    console.error("MERCADOPAGO_INTEREST_FREE_LOOKUP_FAILED", {
      amount,
      message: error instanceof Error ? error.message : "unknown",
    })
    return { status: "unavailable" }
  }
}

/**
 * Cuotas sin interés para un monto, con caché por monto (10 min si Mercado
 * Pago respondió; 1 min si falló, para reintentar pronto sin martillarlo) y
 * una sola consulta en curso por monto. Nunca lanza.
 */
export async function getInterestFreeInstallments(
  amountValue: number,
  dependencies: Dependencies = {},
): Promise<InterestFreeInstallmentsResult> {
  const amount = normalizeInstallmentsAmount(amountValue)
  if (amount === null) return { status: "unavailable" }
  const now = (dependencies.now ?? Date.now)()

  const cached = cache.get(amount)
  if (cached && cached.expiresAt > now) return cached.result

  const pending = inFlight.get(amount)
  if (pending) return pending

  if (!takeLookupBudget(now)) return { status: "unavailable" }

  const request = lookup(amount, dependencies)
    .then((result) => {
      remember(amount, result, (dependencies.now ?? Date.now)())
      return result
    })
    .finally(() => inFlight.delete(amount))
  inFlight.set(amount, request)
  return request
}
