import { INSTALLMENT_COUNTS, type InstallmentCount } from "../products/installments.ts"
import type {
  InterestFreePolicy,
  MercadoPagoInterestFreeStatus,
} from "../mercadopago/interest-free-policy.ts"
import { getFinancedPrice, INSTALLMENTS_COPY } from "./financed-pricing.ts"
import type { InstallmentsFinancingConfig } from "../products/installments.ts"

/**
 * Comunicación GLOBAL de cuotas sin interés ("Hasta N cuotas sin interés a
 * partir de $X"). La financiación no es una propiedad del producto: es una
 * regla general de compra que sale EXCLUSIVAMENTE de lo que Mercado Pago
 * confirma (referencia observada en Admin → Financiación, sincronizada en
 * forma periódica). BEYONIX no agrega mínimos propios: N y $X son los de
 * Mercado Pago (N máximo 6).
 *
 * El texto es sólo comunicación y es el MISMO en Home, categorías, tarjetas,
 * ficha, carrito y checkout: nunca depende del precio de un producto ni del
 * total. Lo que se cobra lo decide siempre la consulta en vivo a Mercado
 * Pago sobre el TOTAL real del checkout, y el servidor la vuelve a validar
 * antes de crear la preferencia.
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
const AMOUNT_FORMAT = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
})

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

/**
 * Texto global estable: "Hasta N cuotas sin interés a partir de $X" (más
 * "con Visa" si la cuota máxima no aplica a todas las marcas de referencia),
 * con N = la mayor cuota que confirma Mercado Pago (máximo 6) y $X su mínimo.
 * Es una regla general de compra: idéntico para todos los productos y
 * pantallas. `null` si no hay oferta vigente: no se comunica ninguna
 * promoción.
 */
export function getInterestFreeMessage(
  offer: PublicInterestFreeOffer | null | undefined,
): InterestFreeMessage | null {
  const tier = offer?.tiers.at(-1)
  if (!tier) return null
  const partial = isPartialBrandCoverage(tier.brands)
  return {
    text: `Hasta ${tier.count} ${INSTALLMENTS_COPY} a partir de ${AMOUNT_FORMAT.format(tier.minimumAmount)}${
      partial ? ` con ${formatInterestFreeBrands(tier.brands)}` : ""
    }`,
    count: tier.count,
    minimumAmount: tier.minimumAmount,
    brands: tier.brands,
  }
}

/**
 * Comunicación de cuotas para UN producto (ficha, modal, tarjeta, hero): sólo
 * si su precio en cuotas alcanza el mínimo que Mercado Pago confirma para ese
 * plan. Se prueba de la mayor cuota a la menor con el precio FINANCIADO de
 * cada una (el que se cobra con Mercado Pago, nunca el de transferencia).
 * Sin plan alcanzable -> `null`: no se muestra nada (nunca un "a partir de
 * $X" que el producto no cumple). El cobro real lo sigue decidiendo el
 * checkout sobre el total.
 */
export function getProductInterestFreeMessage(
  offer: PublicInterestFreeOffer | null | undefined,
  cashPrice: number,
  financing: InstallmentsFinancingConfig,
): InterestFreeMessage | null {
  if (!offer || !Number.isFinite(cashPrice) || cashPrice <= 0) return null
  for (const tier of [...offer.tiers].sort((left, right) => right.count - left.count)) {
    const amount = getFinancedPrice(cashPrice, tier.count, financing) ?? cashPrice
    if (amount < tier.minimumAmount) continue
    const partial = isPartialBrandCoverage(tier.brands)
    return {
      text: `Hasta ${tier.count} ${INSTALLMENTS_COPY}${partial ? ` con ${formatInterestFreeBrands(tier.brands)}` : ""}`,
      count: tier.count,
      minimumAmount: tier.minimumAmount,
      brands: tier.brands,
    }
  }
  return null
}
