import { INSTALLMENT_COUNTS, type InstallmentCount } from "../products/installments.ts"

/**
 * Política PROPIA de BEYONIX sobre las cuotas sin interés que confirma
 * Mercado Pago (lib/mercadopago/interest-free-installments.ts). Mercado Pago
 * sigue siendo la fuente de verdad: BEYONIX sólo puede ser MÁS restrictivo.
 *
 * - `enabled = false`: BEYONIX no ofrece ni comunica cuotas sin interés ni
 *   absorbe financiación (sólo 1 pago a precio contado).
 * - `minimumAmountByCount`: total final mínimo para ofrecer cada rango. El
 *   de 3 rige el rango "hasta 3" (2 y 3 cuotas); el de 6 exige además el de 3.
 *   `null` = sin límite propio (sólo lo que confirma Mercado Pago).
 *
 * Siempre se evalúa contra el monto TOTAL que se cobraría (el carrito
 * completo), nunca producto por producto.
 */
export interface InterestFreePolicy {
  enabled: boolean
  minimumAmountByCount: Record<3 | 6, number | null>
}

export const DEFAULT_INTEREST_FREE_POLICY: InterestFreePolicy = {
  enabled: true,
  minimumAmountByCount: { 3: null, 6: null },
}

/** Mayor monto aceptado como mínimo propio (mismo tope que la consulta a Mercado Pago). */
export const INTEREST_FREE_POLICY_MAX_MINIMUM = 15_000_000

function normalizeMinimum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const amount = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return Math.min(Math.round(amount), INTEREST_FREE_POLICY_MAX_MINIMUM)
}

export function normalizeInterestFreePolicy(value: unknown): InterestFreePolicy {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const minimums =
    source.minimumAmountByCount && typeof source.minimumAmountByCount === "object"
      ? (source.minimumAmountByCount as Record<string, unknown>)
      : {}
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_INTEREST_FREE_POLICY.enabled,
    minimumAmountByCount: {
      3: normalizeMinimum(minimums["3"]),
      6: normalizeMinimum(minimums["6"]),
    },
  }
}

function minimumFor(count: InstallmentCount, policy: InterestFreePolicy) {
  const three = policy.minimumAmountByCount[3] ?? 0
  return count === 6 ? Math.max(three, policy.minimumAmountByCount[6] ?? 0) : three
}

/**
 * Cuotas sin interés que BEYONIX ofrece para un TOTAL: las que confirmó
 * Mercado Pago, filtradas por la política propia. Nunca agrega cuotas que
 * Mercado Pago no confirmó, y conserva la regla "todas las menores también
 * sin interés" (los mínimos crecen con la cantidad de cuotas).
 */
export function applyInterestFreePolicy(
  confirmedCounts: readonly InstallmentCount[],
  totalAmount: number,
  policy: InterestFreePolicy,
): InstallmentCount[] {
  if (!policy.enabled || !Number.isFinite(totalAmount) || totalAmount <= 0) return []
  return INSTALLMENT_COUNTS.filter(
    (count) => confirmedCounts.includes(count) && totalAmount >= minimumFor(count, policy),
  )
}

/** Referencia observada de Mercado Pago: desde qué total confirmó cada rango (estimada sondeando montos). */
export interface MercadoPagoInterestFreeReference {
  checkedAt: string
  /** `null` = Mercado Pago no confirmó ese rango para ningún monto probado. */
  minimumAmountByCount: Record<3 | 6, number | null>
  /** 2 cuotas existe internamente (no es un rango comercial): sólo para informar. */
  minimumAmountForTwo: number | null
  /** Marcas de referencia que confirmaron cada cuota en su mínimo. */
  brandsByCount: Partial<Record<2 | 3 | 6, string[]>>
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
    minimumAmountByCount: { 3: normalizeMinimum(minimums["3"]), 6: normalizeMinimum(minimums["6"]) },
    minimumAmountForTwo: normalizeMinimum(source.minimumAmountForTwo),
    brandsByCount: { 2: normalizeBrands(brands["2"]), 3: normalizeBrands(brands["3"]), 6: normalizeBrands(brands["6"]) },
    maxProbedAmount: Number.isFinite(maxProbedAmount) && maxProbedAmount > 0 ? maxProbedAmount : 0,
  }
}

/**
 * Estado de sincronización con Mercado Pago (`site_settings`): la última
 * referencia OBTENIDA con éxito y el resultado del último intento. Si el
 * último intento falló, la referencia anterior queda sólo como dato
 * histórico: nunca como garantía pública (ver
 * `buildPublicInterestFreeOffer`).
 */
export interface MercadoPagoInterestFreeStatus {
  reference: MercadoPagoInterestFreeReference | null
  lastAttemptAt: string | null
  /** Mensaje resumido (sin secretos) del último intento fallido; `null` si salió bien. */
  lastError: string | null
}

const validDate = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null

export function normalizeMercadoPagoInterestFreeStatus(value: unknown): MercadoPagoInterestFreeStatus {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  // Formato anterior: la referencia guardada directamente (sin estado de sincronización).
  if ("checkedAt" in source && !("reference" in source)) {
    const reference = normalizeMercadoPagoInterestFreeReference(source)
    return { reference, lastAttemptAt: reference?.checkedAt ?? null, lastError: null }
  }
  return {
    reference: normalizeMercadoPagoInterestFreeReference(source.reference),
    lastAttemptAt: validDate(source.lastAttemptAt),
    lastError: typeof source.lastError === "string" && source.lastError.trim() ? source.lastError.trim().slice(0, 200) : null,
  }
}

/**
 * Error de validación (texto para Admin) o `null`. BEYONIX nunca puede
 * ofrecer un rango por debajo de lo que Mercado Pago confirma: un mínimo
 * propio menor que la referencia observada no es válido. El de 6 cuotas no
 * puede ser menor que el de 3.
 */
export function validateInterestFreePolicy(
  policy: InterestFreePolicy,
  reference: MercadoPagoInterestFreeReference | null,
  formatAmount: (amount: number) => string = (amount) => `$ ${amount.toLocaleString("es-AR")}`,
): string | null {
  const three = policy.minimumAmountByCount[3]
  const six = policy.minimumAmountByCount[6]
  if (three !== null && six !== null && six < three) {
    return "El mínimo para 6 cuotas no puede ser menor que el mínimo para 3 cuotas."
  }
  for (const count of [3, 6] as const) {
    const own = policy.minimumAmountByCount[count]
    const mercadoPago = reference?.minimumAmountByCount[count] ?? null
    if (own !== null && mercadoPago !== null && own < mercadoPago) {
      return `El mínimo para ${count} cuotas (${formatAmount(own)}) no puede ser menor que la referencia de Mercado Pago (${formatAmount(mercadoPago)}).`
    }
  }
  return null
}
