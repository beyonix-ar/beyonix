/**
 * Módulo canónico de precios BEYONIX: única fuente de verdad para contado,
 * transferencia y financiado, reutilizada por producto, carrito, checkout,
 * Mercado Pago, Admin y dashboard.
 *
 * MODELO (reemplaza el "precio público único" documentado en
 * `lib/products/installments.ts` hasta esta corrección):
 *
 * 1. CONTADO = `producto.precio` (el precio efectivo vigente -- ya neto de
 *    cualquier descuento/promo aplicado sobre el producto, nunca
 *    `precio_anterior`). Es también el precio de débito/tarjeta en 1 pago.
 * 2. TRANSFERENCIA = contado * (1 - transferDiscountPercent/100).
 * 3. FINANCIADO = contado / (1 - feeRate(maxCount)), donde `maxCount` es la
 *    MAYOR cuota habilitada en la publicación (2/3/6) y `feeRate` es el costo
 *    interno efectivo de Mercado Pago para esa cantidad de cuotas
 *    (`getEffectiveInstallmentPercent`, ya existente). El total financiado NO
 *    cambia según cuántas cuotas elija el cliente -- sólo cambia cuánto vale
 *    cada cuota (`getInstallmentAmount`). Si el cliente elige menos cuotas
 *    que el máximo, el fee REAL que cobra Mercado Pago es menor al usado para
 *    calcular el precio: la diferencia es margen adicional intencional (ver
 *    `mercadopago_payment_snapshot`, fuente de verdad del fee real).
 *
 * El precio financiado NUNCA se persiste como columna -- se deriva siempre de
 * precio + config vigente, igual que el precio por margen objetivo
 * (`lib/pricing/product-pricing.ts`).
 */

import {
  getEffectiveInstallmentPercent,
  getEligibleInstallmentCounts,
  type EligibleInstallmentsProduct,
  type InstallmentCount,
  type InstallmentsFinancingConfig,
} from "../products/installments.ts"

export type { InstallmentCount, InstallmentsFinancingConfig } from "../products/installments.ts"

/**
 * MAYOR cuota habilitada en la publicación, o `null` si no tiene ninguna.
 * `getEligibleInstallmentCounts` ya devuelve en orden ascendente (recorre
 * `INSTALLMENT_COUNTS`), así que el último elemento es el máximo.
 */
export function getMaxEligibleInstallmentCount(
  product: EligibleInstallmentsProduct,
): InstallmentCount | null {
  const counts = getEligibleInstallmentCounts(product)
  return counts.length ? counts[counts.length - 1] : null
}

export function getCashPrice(product: { precio: number }): number {
  return Number.isFinite(product.precio) ? Math.max(product.precio, 0) : 0
}

/**
 * `transferDiscountPercent` sale de `site_settings.pricing` (Admin), nunca
 * hardcodeado acá -- ver `DEFAULT_PRICING_SETTINGS` en `lib/site-settings.ts`.
 */
export function getTransferPrice(
  cashPrice: number,
  transferDiscountPercent: number,
): number {
  const safeCash = Number.isFinite(cashPrice) ? Math.max(cashPrice, 0) : 0
  const rate = Number.isFinite(transferDiscountPercent)
    ? Math.max(0, Math.min(100, transferDiscountPercent)) / 100
    : 0

  return Math.round(safeCash * (1 - rate))
}

/** Costo interno efectivo de MP (fracción 0-1) para la cuota máxima -- insumo del gross-up, nunca se muestra al cliente. */
export function getFinancedFeeRate(
  maxCount: InstallmentCount,
  config: InstallmentsFinancingConfig,
): number {
  return getEffectiveInstallmentPercent(maxCount, config) / 100
}

/**
 * Precio financiado total (constante sin importar qué cuota elija el
 * cliente). `null` si el producto no tiene ninguna cuota habilitada, si el
 * contado no es válido, o si la tasa efectiva es matemáticamente imposible
 * de "resolver" (>=100%, config extrema).
 */
export function getFinancedPrice(
  cashPrice: number,
  maxCount: InstallmentCount | null,
  config: InstallmentsFinancingConfig,
): number | null {
  if (maxCount == null) return null

  const safeCash = Number.isFinite(cashPrice) ? Math.max(cashPrice, 0) : 0
  if (safeCash <= 0) return null

  const feeRate = getFinancedFeeRate(maxCount, config)
  if (feeRate >= 1) return null

  return Math.round(safeCash / (1 - feeRate))
}

/** División simple redondeada al peso -- uso informativo (labels de cuotas). Ver `getInstallmentAmounts` para la variante que garantiza que la suma cierre exacto. */
export function getInstallmentAmount(
  financedPrice: number,
  count: InstallmentCount,
): number | null {
  if (!Number.isFinite(financedPrice) || financedPrice <= 0) return null

  return Math.round(financedPrice / count)
}

/**
 * Igual que `getInstallmentAmount` pero devuelve las `count` cuotas
 * individuales, con la ÚLTIMA absorbiendo el residuo de redondeo: la suma de
 * este array siempre es exactamente `Math.round(financedPrice)`, nunca un
 * total distinto al informado (regla de centavos/checkout).
 */
export function getInstallmentAmounts(
  financedPrice: number,
  count: InstallmentCount,
): number[] | null {
  if (!Number.isFinite(financedPrice) || financedPrice <= 0) return null

  const base = Math.round(financedPrice / count)
  const amounts = new Array<number>(count).fill(base)
  const roundedTotal = Math.round(financedPrice)
  amounts[count - 1] += roundedTotal - base * count

  return amounts
}

export interface InstallmentPlan {
  count: InstallmentCount
  amount: number
}

/**
 * Todas las modalidades elegibles de un producto, en orden ascendente, todas
 * sobre el MISMO `financedPrice` (calculado con la cuota máxima). `[]` si no
 * tiene ninguna cuota habilitada. `cashPrice` se pasa aparte (no se lee de
 * `product.precio`) porque el precio efectivamente mostrado puede diferir
 * del precio base del producto (variante/condicionado con su propio precio).
 */
export function getInstallmentPlans(
  product: EligibleInstallmentsProduct,
  cashPrice: number,
  config: InstallmentsFinancingConfig,
): InstallmentPlan[] {
  const maxCount = getMaxEligibleInstallmentCount(product)
  const financedPrice = getFinancedPrice(cashPrice, maxCount, config)
  if (maxCount == null || financedPrice == null) return []

  return getEligibleInstallmentCounts(product).flatMap((count) => {
    const amount = getInstallmentAmount(financedPrice, count)
    return amount == null ? [] : [{ count, amount }]
  })
}

export interface CartFinanceableLine {
  cashPrice: number
  maxEligibleCount: InstallmentCount | null
  quantity: number
}

/**
 * Total financiado del CARRITO: suma de los precios financiados
 * INDIVIDUALES de cada línea (cada uno calculado con SU propio máximo de
 * cuotas), nunca recalculado con la tasa del mínimo común del carrito. El
 * mínimo común (`getCartInstallmentEligibility`) sólo limita qué cantidades
 * de cuotas se OFRECEN al cliente para pagar este mismo total -- nunca
 * cambia el total en sí. Una línea sin ninguna cuota habilitada aporta su
 * precio de contado (no hay financiado que calcular).
 */
export function getCartFinancedTotal(
  lines: CartFinanceableLine[],
  config: InstallmentsFinancingConfig,
): number {
  return lines.reduce((total, line) => {
    const financedPrice = getFinancedPrice(
      line.cashPrice,
      line.maxEligibleCount,
      config,
    )
    const perUnit = financedPrice ?? getCashPrice({ precio: line.cashPrice })
    return total + perUnit * Math.max(0, line.quantity)
  }, 0)
}

/**
 * "PRECIO SIN IMPUESTOS NACIONALES" (leyenda legal Argentina): `finalPrice`
 * es el precio final mostrado (contado o financiado), `incidencePercent` es
 * la incidencia configurada en Admin (`site_settings.pricing`, nunca
 * hardcodeada -- confirmar con contador).
 */
export function getPriceWithoutNationalTaxes(
  finalPrice: number,
  incidencePercent: number,
): number {
  const safePrice = Number.isFinite(finalPrice) ? Math.max(finalPrice, 0) : 0
  const rate = Number.isFinite(incidencePercent)
    ? Math.max(0, incidencePercent) / 100
    : 0

  if (rate <= 0) return Math.round(safePrice)

  return Math.round(safePrice / (1 + rate))
}

// ─────────────────────────────────────────────────────────────
// CFTEA (Costo Financiero Total Efectivo Anual)
// ─────────────────────────────────────────────────────────────

function presentValueOfEqualInstallments(
  installmentAmount: number,
  count: number,
  monthlyRate: number,
): number {
  let presentValue = 0
  let discountFactor = 1

  for (let installmentIndex = 0; installmentIndex < count; installmentIndex++) {
    discountFactor *= 1 + monthlyRate
    presentValue += installmentAmount / discountFactor
  }

  return presentValue
}

/**
 * Tasa mensual `r` tal que `cashPrice = Σ installmentAmount / (1+r)^k` para
 * k=1..count (cuotas iguales mensuales). Solver puro por bisección: la
 * función es monótona decreciente en `r` (a más tasa, menos valor presente),
 * así que la raíz es única. `null` si no hay costo financiero real que
 * resolver (1 pago, o el total de cuotas no supera al contado).
 */
export function calculateMonthlyFinancingRate(
  cashPrice: number,
  installmentAmount: number,
  count: number,
): number | null {
  if (!Number.isFinite(cashPrice) || cashPrice <= 0) return null
  if (!Number.isFinite(installmentAmount) || installmentAmount <= 0) return null
  if (!Number.isInteger(count) || count <= 1) return null
  if (installmentAmount * count <= cashPrice) return null

  let lo = 0
  // Cota superior generosa (1000% mensual): jamás se alcanza en la práctica,
  // sólo garantiza que la bisección arranque con presentValue(hi) < cashPrice.
  let hi = 10

  for (let iteration = 0; iteration < 100; iteration++) {
    const mid = (lo + hi) / 2
    const presentValue = presentValueOfEqualInstallments(installmentAmount, count, mid)

    if (presentValue > cashPrice) {
      lo = mid
    } else {
      hi = mid
    }
  }

  return (lo + hi) / 2
}

/**
 * CFTEA en % anual, a partir de la tasa mensual resuelta:
 * `(1+r)^12 - 1`. `null` para 1 pago o cuando no hay financiación real (regla
 * legal: nunca se muestra CFTEA en pago único).
 */
export function calculateCftea(
  cashPrice: number,
  installmentAmount: number,
  count: number,
): number | null {
  const monthlyRate = calculateMonthlyFinancingRate(cashPrice, installmentAmount, count)
  if (monthlyRate == null) return null

  return (Math.pow(1 + monthlyRate, 12) - 1) * 100
}
