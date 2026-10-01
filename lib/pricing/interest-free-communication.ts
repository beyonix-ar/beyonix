import type { InstallmentCount } from "../products/installments.ts"
import type {
  InterestFreePolicy,
  MercadoPagoInterestFreeStatus,
} from "../mercadopago/interest-free-policy.ts"
import { INSTALLMENTS_COPY } from "./financed-pricing.ts"

/**
 * Comunicación GLOBAL de cuotas sin interés ("Hasta 6 cuotas sin interés a
 * partir de $X"). La financiación no es una propiedad del producto: es una
 * regla de la tienda que sale de lo que Mercado Pago confirma realmente
 * (referencia observada en Admin → Financiación, sincronizada en forma
 * periódica) y de la política propia de BEYONIX (ON/OFF y mínimos).
 *
 * El texto es sólo comunicación: lo que se cobra lo decide siempre la
 * consulta en vivo a Mercado Pago sobre el TOTAL real del checkout, y el
 * servidor la vuelve a validar antes de crear la preferencia.
 */

/** Sin una sincronización exitosa más reciente que esto, no se comunica ninguna promoción. */
export const INTEREST_FREE_OFFER_MAX_AGE_MS = 2 * 60 * 60 * 1000

export interface PublicInterestFreeTier {
  count: InstallmentCount
  /** Total mínimo a pagar desde el que se ofrece este rango (Mercado Pago y BEYONIX). */
  minimumAmount: number
  /** Marcas de referencia que lo confirman (p. ej. ["visa", "master"]). */
  brands: string[]
}

export interface PublicInterestFreeOffer {
  /** Rangos vigentes ordenados por cantidad de cuotas. */
  tiers: PublicInterestFreeTier[]
  checkedAt: string
}

/**
 * Oferta pública vigente o `null` (no se comunica nada): con cuotas sin
 * interés desactivadas, sin sincronización exitosa reciente, o si el ÚLTIMO
 * intento de consultar a Mercado Pago falló (nunca se usa una referencia
 * vieja como garantía). El mínimo de cada rango es el mayor entre el de
 * Mercado Pago y el propio de BEYONIX: BEYONIX puede ser más restrictivo,
 * nunca crear un rango que Mercado Pago no confirma.
 */
export function buildPublicInterestFreeOffer(
  status: MercadoPagoInterestFreeStatus | null,
  policy: InterestFreePolicy,
  now: Date = new Date(),
): PublicInterestFreeOffer | null {
  const reference = status?.reference
  if (!policy.enabled || !reference || status?.lastError) return null
  const age = now.getTime() - Date.parse(reference.checkedAt)
  if (!Number.isFinite(age) || age < 0 || age > INTEREST_FREE_OFFER_MAX_AGE_MS) return null

  const ownThree = policy.minimumAmountByCount[3] ?? 0
  const ownSix = Math.max(ownThree, policy.minimumAmountByCount[6] ?? 0)
  const candidates: Array<{ count: InstallmentCount; mercadoPago: number | null; own: number }> = [
    { count: 2, mercadoPago: reference.minimumAmountForTwo, own: ownThree },
    { count: 3, mercadoPago: reference.minimumAmountByCount[3], own: ownThree },
    { count: 6, mercadoPago: reference.minimumAmountByCount[6], own: ownSix },
  ]
  const tiers = candidates.flatMap(({ count, mercadoPago, own }) =>
    mercadoPago === null
      ? []
      : [{ count, minimumAmount: Math.max(mercadoPago, own), brands: reference.brandsByCount[count] ?? [] }],
  )
  return tiers.length ? { tiers, checkedAt: reference.checkedAt } : null
}

const BRAND_LABELS: Record<string, string> = { visa: "Visa", master: "Mastercard" }
/** Marcas de referencia que se consultan: si un rango aplica a menos, se aclara cuáles. */
const REFERENCE_BRANDS = ["visa", "master"]
const LIST_FORMAT = new Intl.ListFormat("es-AR", { style: "long", type: "conjunction" })
const AMOUNT_FORMAT = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
})

export function formatInterestFreeBrands(brands: readonly string[]) {
  return LIST_FORMAT.format(brands.map((brand) => BRAND_LABELS[brand] ?? brand))
}

/** El rango aplica sólo a algunas marcas de referencia: hay que decir cuáles (nunca prometer compatibilidad universal). */
export function isPartialBrandCoverage(brands: readonly string[]) {
  return brands.length > 0 && REFERENCE_BRANDS.some((brand) => !brands.includes(brand))
}

export interface InterestFreeMessage {
  text: string
  count: InstallmentCount
  minimumAmount: number
  brands: string[]
  /** El monto consultado ya alcanza este rango. */
  qualifies: boolean
}

/**
 * Texto global estable: "Hasta N cuotas sin interés a partir de $X" (más
 * "con Visa" si el rango no aplica a todas las marcas de referencia). Sólo
 * cambian N y $X:
 * - sin monto (Home, categorías): el mayor rango vigente;
 * - con monto (PDP, carrito, checkout): el mayor rango que ese total ya
 *   alcanza o, si todavía no alcanza ninguno, el primero (desde cuánto).
 * `null` si no hay oferta vigente: no se comunica ninguna promoción.
 */
export function getInterestFreeMessage(
  offer: PublicInterestFreeOffer | null | undefined,
  amount?: number | null,
): InterestFreeMessage | null {
  const tiers = offer?.tiers ?? []
  if (!tiers.length) return null
  const hasAmount = typeof amount === "number" && Number.isFinite(amount)
  const reached = hasAmount ? tiers.filter((tier) => tier.minimumAmount <= amount) : tiers
  const tier = reached.at(-1) ?? tiers[0]
  const partial = isPartialBrandCoverage(tier.brands)
  return {
    text: `Hasta ${tier.count} ${INSTALLMENTS_COPY} a partir de ${AMOUNT_FORMAT.format(tier.minimumAmount)}${
      partial ? ` con ${formatInterestFreeBrands(tier.brands)}` : ""
    }`,
    count: tier.count,
    minimumAmount: tier.minimumAmount,
    brands: tier.brands,
    qualifies: hasAmount ? tier.minimumAmount <= amount : true,
  }
}
