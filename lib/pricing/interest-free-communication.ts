import { INSTALLMENT_COUNTS, type InstallmentCount } from "../products/installments.ts"
import type {
  InterestFreePolicy,
  MercadoPagoInterestFreeStatus,
} from "../mercadopago/interest-free-policy.ts"
import { formatInstallmentsAmount, getFinancedPrice, getInstallmentAmount, INSTALLMENTS_COPY } from "./financed-pricing.ts"
import type { InstallmentsFinancingConfig } from "../products/installments.ts"
import type { FinancedPricePolicy } from "./financed-price-policy.ts"

/**
 * Comunicación de cuotas. Las cuotas que se ofrecen salen EXCLUSIVAMENTE de
 * lo que Mercado Pago confirma (referencia observada en Admin →
 * Financiación, sincronizada en forma periódica). BEYONIX no agrega mínimos
 * propios: N y $X son los de Mercado Pago (N máximo 6), medidos sobre el
 * total que se cobra en cuotas.
 *
 * Carrito y checkout usan el texto global (`getInterestFreeMessage`); Home,
 * tarjetas, hero y ficha, el del producto (`getProductInterestFreeMessage`).
 * Con `cover_costs` ninguno dice "sin interés": el total en cuotas es mayor
 * que el contado. Es sólo comunicación: lo que se cobra lo decide siempre la
 * consulta en vivo a Mercado Pago sobre el TOTAL real del checkout, y el
 * servidor la vuelve a validar antes de crear la preferencia.
 */

/** Sin una sincronización exitosa más reciente que esto, no se comunica ninguna promoción. */
export const INTEREST_FREE_OFFER_MAX_AGE_MS = 2 * 60 * 60 * 1000

export interface PublicInterestFreeTier {
  count: InstallmentCount
  /** Total mínimo a pagar desde el que Mercado Pago confirma esta cuota sin interés. */
  minimumAmount: number
  /** Marcas de referencia que lo confirman (p. ej. ["visa", "master"]). */
  brands: string[]
}

export interface PublicInterestFreeOffer {
  /** Cuotas vigentes ordenadas por cantidad. */
  tiers: PublicInterestFreeTier[]
  checkedAt: string
}

/**
 * Oferta pública vigente o `null` (no se comunica nada): con cuotas sin
 * interés desactivadas, sin sincronización exitosa reciente, o si el ÚLTIMO
 * intento de consultar a Mercado Pago falló (nunca se usa una referencia
 * vieja como garantía). Cada cuota usa el mínimo que confirmó Mercado Pago.
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

  const tiers = INSTALLMENT_COUNTS.flatMap((count) => {
    const minimumAmount = reference.minimumAmountByCount[count]
    return minimumAmount === null
      ? []
      : [{ count, minimumAmount, brands: reference.brandsByCount[count] ?? [] }]
  })
  return tiers.length ? { tiers, checkedAt: reference.checkedAt } : null
}

const BRAND_LABELS: Record<string, string> = { visa: "Visa", master: "Mastercard" }
/** Marcas de referencia que se consultan: si una cuota aplica a menos, se aclara cuáles. */
const REFERENCE_BRANDS = ["visa", "master"]
const LIST_FORMAT = new Intl.ListFormat("es-AR", { style: "long", type: "conjunction" })

export function formatInterestFreeBrands(brands: readonly string[]) {
  return LIST_FORMAT.format(brands.map((brand) => BRAND_LABELS[brand] ?? brand))
}

/** La cuota aplica sólo a algunas marcas de referencia: hay que decir cuáles (nunca prometer compatibilidad universal). */
export function isPartialBrandCoverage(brands: readonly string[]) {
  return brands.length > 0 && REFERENCE_BRANDS.some((brand) => !brands.includes(brand))
}

export interface InterestFreeMessage {
  text: string
  count: InstallmentCount
  minimumAmount: number
  brands: string[]
}

const brandSuffix = (brands: readonly string[]) =>
  isPartialBrandCoverage(brands) ? ` con ${formatInterestFreeBrands(brands)}` : ""

/**
 * Texto global estable, con N = la mayor cuota que confirma Mercado Pago
 * (máximo 6) y $X su mínimo (más "con Visa" si no aplica a todas las marcas
 * de referencia). Es una regla general de compra: idéntico para todos los
 * productos y pantallas. El mínimo de Mercado Pago se mide sobre el TOTAL
 * QUE SE COBRA en cuotas, y el texto lo dice según la política:
 *
 * - `same_as_cash`: total en cuotas = contado -> "Hasta N cuotas sin
 *   interés a partir de $X".
 * - `cover_costs`: el total en cuotas es MAYOR que el contado (BEYONIX
 *   trasladó el costo de financiación) -> nunca "sin interés":
 *   "Hasta N cuotas con total financiado desde $X".
 *
 * `null` si no hay oferta vigente: no se comunica ninguna promoción.
 */
export function getInterestFreeMessage(
  offer: PublicInterestFreeOffer | null | undefined,
  policy: FinancedPricePolicy,
): InterestFreeMessage | null {
  const tier = offer?.tiers.at(-1)
  if (!tier) return null
  const minimum = formatInstallmentsAmount(tier.minimumAmount)
  return {
    text: policy === "same_as_cash"
      ? `Hasta ${tier.count} ${INSTALLMENTS_COPY} a partir de ${minimum}${brandSuffix(tier.brands)}`
      : `Hasta ${tier.count} cuotas con total financiado desde ${minimum}${brandSuffix(tier.brands)}`,
    count: tier.count,
    minimumAmount: tier.minimumAmount,
    brands: tier.brands,
  }
}

export interface ProductInstallmentsMessage extends InterestFreeMessage {
  /** Total que se cobra en cuotas: igual al contado sólo con `same_as_cash`. */
  financedTotal: number
  /** Importe de cada una de las `count` cuotas sobre `financedTotal`. */
  installmentAmount: number
  /** "sin interés" sólo es veraz si el total en cuotas es el de contado. */
  interestFree: boolean
  /** "Total financiado: $Y" cuando difiere del contado (tooltip / ficha). */
  financedTotalText: string | null
}

/**
 * Comunicación de cuotas para UN producto (ficha, modal, tarjeta, hero): sólo
 * si el total que se cobraría en cuotas alcanza el mínimo que Mercado Pago
 * confirma para ese plan. Se prueba de la mayor cuota a la menor con el
 * mismo total que usa el checkout (`cover_costs`: financiado de esa cuota;
 * `same_as_cash`: contado), nunca el de transferencia.
 *
 * - `same_as_cash` (total = contado): "Hasta N cuotas sin interés".
 * - `cover_costs` (total > contado): "N cuotas de $X" + "Total financiado:
 *   $Y". Nunca "sin interés" junto al precio de contado: aunque Mercado Pago
 *   no cobre interés sobre el total, BEYONIX ya trasladó el costo al precio.
 *
 * Sin plan alcanzable -> `null`: no se muestra nada. El cobro real lo sigue
 * decidiendo el checkout sobre el total.
 */
export function getProductInterestFreeMessage(
  offer: PublicInterestFreeOffer | null | undefined,
  cashPrice: number,
  financing: InstallmentsFinancingConfig,
  policy: FinancedPricePolicy,
): ProductInstallmentsMessage | null {
  if (!offer || !Number.isFinite(cashPrice) || cashPrice <= 0) return null
  for (const tier of [...offer.tiers].sort((left, right) => right.count - left.count)) {
    const financedTotal = policy === "same_as_cash"
      ? cashPrice
      : getFinancedPrice(cashPrice, tier.count, financing)
    if (financedTotal == null || financedTotal < tier.minimumAmount) continue
    const installmentAmount = getInstallmentAmount(financedTotal, tier.count)
    if (installmentAmount == null) continue
    const interestFree = financedTotal <= cashPrice
    const brands = brandSuffix(tier.brands)
    return {
      text: interestFree
        ? `Hasta ${tier.count} ${INSTALLMENTS_COPY}${brands}`
        : `${tier.count} cuotas de ${formatInstallmentsAmount(installmentAmount)}${brands}`,
      count: tier.count,
      minimumAmount: tier.minimumAmount,
      brands: tier.brands,
      financedTotal,
      installmentAmount,
      interestFree,
      financedTotalText: interestFree ? null : `Total financiado: ${formatInstallmentsAmount(financedTotal)}`,
    }
  }
  return null
}
