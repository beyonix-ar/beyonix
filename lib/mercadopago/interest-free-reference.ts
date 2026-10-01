import type { InstallmentCount } from "../products/installments.ts"
import type { InterestFreeBrand, InterestFreeInstallmentsResult } from "./interest-free-installments.ts"
import type { MercadoPagoInterestFreeReference } from "./interest-free-policy.ts"

/**
 * Referencia observada de Mercado Pago: desde qué total confirma cada cuota
 * sin interés.
 *
 * Mercado Pago NO expone ese umbral: `payer_costs[].min_allowed_amount` es el
 * mínimo genérico del medio de pago (≈ $3), no el de la promoción sin interés
 * (verificado contra la API real). Lo único honesto es consultar la misma
 * disponibilidad por monto que usa el checkout.
 *
 * Cada cuota (2, 3 y 6) se busca POR SEPARADO: que aparezca 2 no corta la
 * búsqueda de 3, y "hasta 2" nunca se confunde con "hasta 3". Primero se
 * recorre una escalera de montos de menor a mayor hasta el primero que
 * confirma esa cuota; después, búsqueda binaria en pasos de $1.000 entre el
 * último monto de la escalera que NO la confirmaba y ese primero que sí. Así
 * un hueco más arriba en la escalera no puede producir un mínimo falso. Las
 * consultas se comparten entre cuotas (caché por monto).
 */

export const REFERENCE_PROBE_STEP = 1_000
/** Escalera de montos (no son umbrales de negocio: sólo acotan la búsqueda). */
export const REFERENCE_PROBE_LADDER = [
  1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 50_000, 75_000, 100_000, 150_000, 250_000, 500_000, 1_000_000, 2_000_000,
] as const
export const REFERENCE_PROBE_MAX_AMOUNT = REFERENCE_PROBE_LADDER[REFERENCE_PROBE_LADDER.length - 1]

type Lookup = (amount: number) => Promise<InterestFreeInstallmentsResult>

type ProbeResult =
  | { status: "ok"; minimum: number | null; brands: InterestFreeBrand[] }
  | { status: "unavailable" }

export async function probeInterestFreeMinimum(count: InstallmentCount, lookup: Lookup): Promise<ProbeResult> {
  const check = async (amount: number) => {
    const result = await lookup(amount)
    if (result.status !== "confirmed") return null
    return result.counts.includes(count) ? { brands: result.brandsByCount?.[count] ?? [] } : false
  }

  let lowerBound = 0
  for (const amount of REFERENCE_PROBE_LADDER) {
    const result = await check(amount)
    if (result === null) return { status: "unavailable" }
    if (!result) {
      lowerBound = amount
      continue
    }

    // `lowerBound` no confirma (o es 0); `amount` confirma.
    let low = lowerBound
    let high: number = amount
    let brands = result.brands
    while (high - low > REFERENCE_PROBE_STEP) {
      const middle = low + Math.floor((high - low) / 2 / REFERENCE_PROBE_STEP) * REFERENCE_PROBE_STEP
      const midResult = await check(middle)
      if (midResult === null) return { status: "unavailable" }
      if (midResult) {
        high = middle
        brands = midResult.brands
      } else {
        low = middle
      }
    }
    return { status: "ok", minimum: high, brands }
  }
  return { status: "ok", minimum: null, brands: [] }
}

/** `null` si Mercado Pago no respondió de forma confiable: nunca se guarda una referencia inventada. */
export async function probeMercadoPagoInterestFreeReference(
  lookup: Lookup,
  now: Date = new Date(),
): Promise<MercadoPagoInterestFreeReference | null> {
  const results = {} as Record<InstallmentCount, Extract<ProbeResult, { status: "ok" }>>
  for (const count of [2, 3, 6] as const) {
    const result = await probeInterestFreeMinimum(count, lookup)
    if (result.status === "unavailable") return null
    results[count] = result
  }
  return {
    checkedAt: now.toISOString(),
    minimumAmountByCount: { 3: results[3].minimum, 6: results[6].minimum },
    minimumAmountForTwo: results[2].minimum,
    brandsByCount: { 2: results[2].brands, 3: results[3].brands, 6: results[6].brands },
    maxProbedAmount: REFERENCE_PROBE_MAX_AMOUNT,
  }
}
