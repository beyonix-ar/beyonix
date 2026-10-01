import { INSTALLMENT_COUNTS, type InstallmentCount } from "../products/installments.ts"

/**
 * Política de BEYONIX sobre las cuotas sin interés que confirma Mercado Pago
 * (lib/mercadopago/interest-free-installments.ts). Mercado Pago es la fuente
 * de verdad: BEYONIX ofrece EXACTAMENTE las cuotas sin interés que Mercado
 * Pago confirma para el total (máximo 6), desde el mismo monto, sin mínimos
 * propios que adelanten o retrasen una promoción.
 *
 * - `enabled = false`: BEYONIX no ofrece ni comunica cuotas sin interés ni
 *   absorbe financiación (sólo 1 pago a precio contado). Tampoco consulta a
 *   Mercado Pago para ofrecer promociones.
 *
 * Los mínimos propios que existieron antes (`minimumAmountByCount`) se
 * ignoran al leer la configuración guardada.
 */
export interface InterestFreePolicy {
  enabled: boolean
}

export const DEFAULT_INTEREST_FREE_POLICY: InterestFreePolicy = {
  enabled: true,
}

/** Mayor monto aceptado en una referencia guardada (mismo tope que la consulta a Mercado Pago). */
const REFERENCE_MAX_AMOUNT = 15_000_000

function normalizeAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const amount = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return Math.min(Math.round(amount), REFERENCE_MAX_AMOUNT)
}

export function normalizeInterestFreePolicy(value: unknown): InterestFreePolicy {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_INTEREST_FREE_POLICY.enabled,
  }
}

/**
 * Referencia observada de Mercado Pago: desde qué total confirmó cada cuota
 * sin interés (estimada sondeando montos, ver interest-free-reference.ts).
 */
export interface MercadoPagoInterestFreeReference {
  checkedAt: string
  /** `null` = Mercado Pago no confirmó esa cuota para ningún monto probado. */
  minimumAmountByCount: Record<InstallmentCount, number | null>
  /** Marcas de referencia que confirmaron cada cuota en su mínimo. */
  brandsByCount: Partial<Record<InstallmentCount, string[]>>
  /** Mayor monto probado. */
  maxProbedAmount: number
}

function normalizeBrands(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((brand): brand is string => typeof brand === "string").slice(0, 4) : []
}

export function normalizeMercadoPagoInterestFreeReference(value: unknown): MercadoPagoInterestFreeReference | null {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : null
  if (!source || typeof source.checkedAt !== "string" || !Number.isFinite(Date.parse(source.checkedAt))) return null
  const minimums =
    source.minimumAmountByCount && typeof source.minimumAmountByCount === "object"
      ? (source.minimumAmountByCount as Record<string, unknown>)
      : {}
  const maxProbedAmount = Number(source.maxProbedAmount)
  const brands =
    source.brandsByCount && typeof source.brandsByCount === "object"
      ? (source.brandsByCount as Record<string, unknown>)
      : {}
  return {
    checkedAt: source.checkedAt,
    minimumAmountByCount: {
      // Formato anterior: 2 cuotas se guardaba aparte (`minimumAmountForTwo`).
      2: normalizeAmount(minimums["2"] ?? source.minimumAmountForTwo),
      3: normalizeAmount(minimums["3"]),
      6: normalizeAmount(minimums["6"]),
    },
    brandsByCount: Object.fromEntries(INSTALLMENT_COUNTS.map((count) => [count, normalizeBrands(brands[String(count)])])),
    maxProbedAmount: Number.isFinite(maxProbedAmount) && maxProbedAmount > 0 ? maxProbedAmount : 0,
  }
}

/**
 * Cuota sin interés más alta que confirma la referencia (máximo comercial 6)
 * con su monto mínimo estimado y marcas. `null` si no confirma ninguna.
 */
export function getConfirmedInterestFreeMax(
  reference: MercadoPagoInterestFreeReference | null,
): { count: InstallmentCount; minimumAmount: number; brands: string[] } | null {
  if (!reference) return null
  for (const count of [...INSTALLMENT_COUNTS].reverse()) {
    const minimumAmount = reference.minimumAmountByCount[count]
    if (minimumAmount !== null) return { count, minimumAmount, brands: reference.brandsByCount[count] ?? [] }
  }
  return null
}

/**
 * Estado de sincronización con Mercado Pago (`site_settings`): la última
 * referencia OBTENIDA con éxito, el resultado del último intento y el último
 * fallo registrado (se conserva aunque después vuelva a funcionar). Si el
 * último intento falló, la referencia anterior queda sólo como dato
 * histórico: nunca como garantía pública (ver `buildPublicInterestFreeOffer`).
 */
export interface MercadoPagoInterestFreeStatus {
  reference: MercadoPagoInterestFreeReference | null
  lastAttemptAt: string | null
  /** Mensaje resumido (sin secretos) del último intento si falló; `null` si salió bien. */
  lastError: string | null
  /** Último fallo registrado (histórico para Admin). */
  lastFailure: { at: string; message: string } | null
}

const validDate = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null

const shortMessage = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null

export function normalizeMercadoPagoInterestFreeStatus(value: unknown): MercadoPagoInterestFreeStatus {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  // Formato anterior: la referencia guardada directamente (sin estado de sincronización).
  if ("checkedAt" in source && !("reference" in source)) {
    const reference = normalizeMercadoPagoInterestFreeReference(source)
    return { reference, lastAttemptAt: reference?.checkedAt ?? null, lastError: null, lastFailure: null }
  }
  const lastAttemptAt = validDate(source.lastAttemptAt)
  const lastError = shortMessage(source.lastError)
  const failure = source.lastFailure && typeof source.lastFailure === "object"
    ? (source.lastFailure as Record<string, unknown>)
    : null
  const failureAt = validDate(failure?.at)
  const failureMessage = shortMessage(failure?.message)
  return {
    reference: normalizeMercadoPagoInterestFreeReference(source.reference),
    lastAttemptAt,
    lastError,
    lastFailure:
      failureAt && failureMessage
        ? { at: failureAt, message: failureMessage }
        : lastError && lastAttemptAt
          ? { at: lastAttemptAt, message: lastError }
          : null,
  }
}
