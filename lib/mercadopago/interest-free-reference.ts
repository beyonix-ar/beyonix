import { INSTALLMENT_COUNTS, type InstallmentCount } from "../products/installments.ts"
import type {
  InterestFreeBrand,
  InterestFreeInstallmentsResult,
  InterestFreeUnavailableReason,
} from "./interest-free-installments.ts"
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
 * un hueco más arriba en la escalera no puede producir un mínimo falso. Dentro
 * de una corrida, cada monto se consulta una sola vez (`memoizeLookup`).
 * Ningún umbral está fijo en el código: si Mercado Pago activa 3 o 6 cuotas
 * mañana, la próxima sincronización encuentra su mínimo sola.
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
  | { status: "unavailable"; reason?: InterestFreeUnavailableReason }

export async function probeInterestFreeMinimum(count: InstallmentCount, lookup: Lookup): Promise<ProbeResult> {
  let failure: InterestFreeUnavailableReason | undefined
  const check = async (amount: number) => {
    const result = await lookup(amount)
    if (result.status !== "confirmed") {
      failure = result.reason
      return null
    }
    return result.counts.includes(count) ? { brands: result.brandsByCount?.[count] ?? [] } : false
  }

  let lowerBound = 0
  for (const amount of REFERENCE_PROBE_LADDER) {
    const result = await check(amount)
    if (result === null) return { status: "unavailable", reason: failure }
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
      if (midResult === null) return { status: "unavailable", reason: failure }
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

/**
 * Una misma corrida consulta cada monto UNA vez aunque lo necesiten varias
 * cuotas (la consulta fresca no pasa por la caché compartida).
 */
export function memoizeLookup(lookup: Lookup): Lookup {
  const results = new Map<number, Promise<InterestFreeInstallmentsResult>>()
  return (amount) => {
    const existing = results.get(amount)
    if (existing) return existing
    const request = lookup(amount)
    results.set(amount, request)
    return request
  }
}

export type MercadoPagoInterestFreeProbe =
  | { ok: true; reference: MercadoPagoInterestFreeReference }
  | { ok: false; reason?: InterestFreeUnavailableReason }

/**
 * Busca 2, 3 y 6 cuotas por separado. Si Mercado Pago no respondió de forma
 * confiable devuelve el motivo: nunca se guarda una referencia inventada.
 */
export async function probeMercadoPagoInterestFreeReference(
  lookup: Lookup,
  now: Date = new Date(),
): Promise<MercadoPagoInterestFreeProbe> {
  const memoized = memoizeLookup(lookup)
  const results = {} as Record<InstallmentCount, Extract<ProbeResult, { status: "ok" }>>
  for (const count of INSTALLMENT_COUNTS) {
    const result = await probeInterestFreeMinimum(count, memoized)
    if (result.status === "unavailable") return { ok: false, reason: result.reason }
    results[count] = result
  }
  return {
    ok: true,
    reference: {
      checkedAt: now.toISOString(),
      minimumAmountByCount: { 2: results[2].minimum, 3: results[3].minimum, 6: results[6].minimum },
      brandsByCount: { 2: results[2].brands, 3: results[3].brands, 6: results[6].brands },
      maxProbedAmount: REFERENCE_PROBE_MAX_AMOUNT,
    },
  }
}
