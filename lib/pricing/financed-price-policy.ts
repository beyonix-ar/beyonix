/**
 * Política GLOBAL de precio financiado (Admin → Financiación):
 *
 * - `cover_costs` (habitual): el precio en cuotas cubre los costos de Mercado
 *   Pago (comisión base + financiación + IVA + redondeo de seguridad).
 * - `same_as_cash`: el total en cuotas sin interés es EXACTAMENTE el de
 *   contado; BEYONIX absorbe conscientemente el costo de financiación.
 *
 * En ambas, qué cuotas se ofrecen lo decide SIEMPRE Mercado Pago (máximo 6):
 * esta política no crea promociones. Vive en su propia clave de
 * `site_settings` (`financed_price_policy`) para que un evento programado la
 * cambie y la restaure sin tocar costos ni modo.
 */

export const FINANCED_PRICE_POLICIES = ["cover_costs", "same_as_cash"] as const
export type FinancedPricePolicy = (typeof FINANCED_PRICE_POLICIES)[number]

export const DEFAULT_FINANCED_PRICE_POLICY: FinancedPricePolicy = "cover_costs"
export const FINANCED_PRICE_POLICY_KEY = "financed_price_policy"

export const FINANCED_PRICE_POLICY_LABELS: Record<FinancedPricePolicy, string> = {
  cover_costs: "Cubrir costos de Mercado Pago",
  same_as_cash: "Mismo precio que contado",
}

/** Advertencia (Financiación y Eventos) cuando BEYONIX absorbe la financiación. */
export const SAME_AS_CASH_WARNING =
  "BEYONIX absorberá las comisiones y costos de financiación de Mercado Pago durante esta modalidad."

export function isFinancedPricePolicy(value: unknown): value is FinancedPricePolicy {
  return typeof value === "string" && (FINANCED_PRICE_POLICIES as readonly string[]).includes(value)
}

/** Lo guardado (`{ policy, eventId? }`) o el default. Nunca falla. */
export function normalizeFinancedPricePolicy(value: unknown): FinancedPricePolicy {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return isFinancedPricePolicy(source.policy) ? source.policy : DEFAULT_FINANCED_PRICE_POLICY
}
