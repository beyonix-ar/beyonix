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
 * 3. FINANCIADO = contado / (1 - feeRate(tier)), donde `tier` es la MAYOR
 *    cuota SIN INTERÉS que Mercado Pago confirma para ese monto
 *    (`resolveFinancingTier`), limitada a las cuotas que admite el producto,
 *    y `feeRate` es el costo interno efectivo de Mercado Pago para esa
 *    cantidad de cuotas (`getEffectiveInstallmentPercent`). La cuota
 *    configurada NUNCA define el precio por sí sola. El total financiado NO
 *    cambia según cuántas cuotas elija el cliente dentro del tier -- sólo
 *    cambia cuánto vale cada cuota (`getInstallmentAmount`). 1 pago es
 *    siempre CONTADO.
 *    El resultado se redondea HACIA ARRIBA al múltiplo común de las cuotas
 *    (`getFinancedPriceDivisor`), así N cuotas x monto cierran exacto.
 * 4. CUOTAS SIN RECARGO (`cuotas_sin_recargo`, por producto, heredado por sus
 *    variantes): FINANCIADO = CONTADO, sin gross-up ni redondeo. BEYONIX
 *    absorbe el costo de Mercado Pago. Ver `getProductFinancedPriceForCount`.
 *
 * El precio financiado NUNCA se persiste como columna -- se deriva siempre de
 * precio + config vigente, igual que el precio por margen objetivo
 * (`lib/pricing/product-pricing.ts`).
 */

import {
  INSTALLMENT_COUNTS,
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
 * cliente), en pesos enteros y redondeado hacia arriba al múltiplo de
 * `getFinancedPriceDivisor(maxCount)` -- nunca se ajustan cuotas
 * individuales para esconder diferencias. `null` si el producto no tiene ninguna cuota habilitada, si el
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

  // Tolerancia de punto flotante: un gross-up que da 63018.0000000001 no
  // debe saltar al múltiplo siguiente.
  const grossUpPesos = Math.ceil(safeCash / (1 - feeRate) - 1e-6)
  const divisor = getFinancedPriceDivisor(maxCount)

  return Math.ceil(grossUpPesos / divisor) * divisor
}

/**
 * `true` sólo si el producto tiene "Mismo precio en contado y cuotas" Y al
 * menos una cuota habilitada: el flag solo nunca habilita cuotas.
 */
export function hasInstallmentsWithoutSurcharge(
  product: EligibleInstallmentsProduct,
): boolean {
  return (
    product.cuotas_sin_recargo === true &&
    getMaxEligibleInstallmentCount(product) != null
  )
}

/**
 * Copy de cara al cliente para las cuotas ("Hasta N {copy} de $X"), igual
 * para todos los productos y para el checkout: siempre "sin interés", nunca
 * "sin recargo". La regla de precio de cada producto (`cuotas_sin_recargo`)
 * sigue definiendo sólo el importe, no el texto.
 */
export const INSTALLMENTS_COPY = "cuotas sin interés"

/**
 * Precio financiado de UN producto calculado con el costo de `count` cuotas
 * (el TIER que habilita Mercado Pago, nunca la cuota configurada a ciegas).
 * Con "Mismo precio en contado y cuotas" es el contado. `null` si el producto
 * no admite esa cuota o el contado no es válido.
 */
export function getProductFinancedPriceForCount(
  product: EligibleInstallmentsProduct,
  cashPrice: number,
  count: InstallmentCount,
  config: InstallmentsFinancingConfig,
): number | null {
  if (!getEligibleInstallmentCounts(product).includes(count)) return null
  if (product.cuotas_sin_recargo === true) {
    const safeCash = Number.isFinite(cashPrice) ? Math.max(cashPrice, 0) : 0
    return safeCash > 0 ? safeCash : null
  }
  return getFinancedPrice(cashPrice, count, config)
}

/**
 * Cuotas sin interés que Mercado Pago confirma para un monto: `undefined`
 * mientras se consulta, `null` si no se pudo confirmar.
 */
export type InterestFreeLookup = (
  amount: number,
) => readonly InstallmentCount[] | null | undefined

export interface FinancingTierCandidate {
  count: InstallmentCount
  /** Monto que cobraría Mercado Pago con este tier (sobre el que se consulta). */
  amount: number
}

/**
 * TIER de financiación: la MAYOR cuota que Mercado Pago confirma sin interés
 * para el monto calculado con el costo de ESA cuota. Se prueba de mayor a
 * menor (el precio de un tier más alto es mayor, así que si califica, cubre
 * el peor costo dentro de lo habilitado). Sin confirmación -> `null`: 1 pago
 * a precio contado. Las cuotas ofrecidas son las elegibles <= tier que
 * Mercado Pago confirmó para ese mismo monto.
 */
export function resolveFinancingTier(
  candidates: readonly FinancingTierCandidate[],
  eligibleCounts: readonly InstallmentCount[],
  lookup: InterestFreeLookup | null,
): { tier: FinancingTierCandidate; offeredCounts: InstallmentCount[] } | null {
  if (!lookup) return null
  for (const candidate of [...candidates].sort((left, right) => right.count - left.count)) {
    const confirmed = lookup(candidate.amount)
    // Todavía consultando un tier más alto: no se baja a uno menor (el
    // precio cambiaría al llegar la respuesta). Sin cuotas por ahora.
    if (confirmed === undefined) return null
    if (!confirmed?.includes(candidate.count)) continue
    return {
      tier: candidate,
      offeredCounts: eligibleCounts.filter(
        (count) => count <= candidate.count && confirmed.includes(count),
      ),
    }
  }
  return null
}

export interface ProductInterestFreeOffer {
  /** Tier: cuota máxima sin interés confirmada para este precio. */
  count: InstallmentCount
  /** Precio financiado calculado con el costo del tier (igual para 2/3/6 dentro del tier). */
  financedPrice: number
  plans: InstallmentPlan[]
}

/** Precios por tier del producto (los montos que hay que consultar a Mercado Pago). */
export function getProductFinancingCandidates(
  product: EligibleInstallmentsProduct,
  cashPrice: number,
  config: InstallmentsFinancingConfig,
): FinancingTierCandidate[] {
  return getEligibleInstallmentCounts(product).flatMap((count) => {
    const amount = getProductFinancedPriceForCount(product, cashPrice, count, config)
    return amount == null ? [] : [{ count, amount }]
  })
}

/**
 * Oferta de cuotas sin interés de UN producto (1 unidad, sin envío: lo más
 * conservador que se puede prometer antes del carrito). `null` si Mercado
 * Pago no confirma ninguna: no se promete "sin interés".
 */
export function getProductInterestFreeOffer(
  product: EligibleInstallmentsProduct,
  cashPrice: number,
  config: InstallmentsFinancingConfig,
  lookup: InterestFreeLookup | null,
): ProductInterestFreeOffer | null {
  const resolved = resolveFinancingTier(
    getProductFinancingCandidates(product, cashPrice, config),
    getEligibleInstallmentCounts(product),
    lookup,
  )
  if (!resolved) return null
  const financedPrice = resolved.tier.amount
  return {
    count: resolved.tier.count,
    financedPrice,
    plans: resolved.offeredCounts.flatMap((count) => {
      const amount = getInstallmentAmount(financedPrice, count)
      return amount == null ? [] : [{ count, amount }]
    }),
  }
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b)
}

/**
 * Múltiplo al que se redondea HACIA ARRIBA el financiado: mínimo común
 * múltiplo de todas las cantidades de cuotas <= `maxCount` (máx. 6 -> 6,
 * máx. 3 -> 6, máx. 2 -> 2). Cubre cualquier combinación habilitada con ese
 * máximo, así que cada cuota ofrecida divide el total EXACTO, sin residuo:
 * el total financiado es idéntico elija el cliente 2, 3 o 6 cuotas.
 */
export function getFinancedPriceDivisor(maxCount: InstallmentCount): number {
  return getInstallmentCountsDivisor(
    INSTALLMENT_COUNTS.filter((count) => count <= maxCount),
  )
}

/** Mínimo común múltiplo de las cuotas dadas (`1` si no hay ninguna). */
export function getInstallmentCountsDivisor(
  counts: readonly InstallmentCount[],
): number {
  return counts.reduce(
    (lcm, count) => (lcm * count) / greatestCommonDivisor(lcm, count),
    1,
  )
}

export interface InstallmentsRoundedCheckoutTotal {
  /** Total de la orden (antes de saldo a favor), ya con `roundingAdjustment` incluido. */
  total: number
  /** Lo que efectivamente se cobra por Mercado Pago: `total - customerCreditApplied`. */
  externalAmountDue: number
  /** Saldo a favor que efectivamente se aplica (<= el solicitado). */
  customerCreditApplied: number
  /** Ajuste de redondeo final de cuotas (>= 0, menor a divisor centavos). */
  roundingAdjustment: number
}

/**
 * AJUSTE DE REDONDEO FINAL DE CUOTAS del checkout financiado, en centavos
 * enteros y con divisor = mínimo común de las cuotas OFRECIDAS (no de la
 * elegida, así 2/3/6 cobran el mismo total):
 *
 * - `total` (productos financiados + envío - beneficio) se lleva HACIA ARRIBA
 *   al próximo múltiplo del divisor, UNA sola vez. No depende del saldo.
 * - El saldo a favor aplicado se lleva HACIA ABAJO al múltiplo del divisor
 *   (a lo sumo divisor-1 centavos quedan en la billetera, nunca se pierden).
 *
 * Así `total`, saldo y `externalAmountDue = total - saldo` son TODOS
 * divisibles por cada cuota ofrecida, y se conserva
 * `total = externalAmountDue + saldo` (invariante que recalculan las RPC de
 * saldo a favor sobre `original_total`): si `reverse_customer_credit_for_order`
 * restaura `external_amount_due = original_total`, el monto restaurado sigue
 * dividiendo exacto sin repetir esta lógica en SQL. Si el saldo cubre todo
 * no hay nada que financiar ni redondear. Nunca toca el envío.
 */
export function roundUpCheckoutTotalForInstallments({
  total,
  customerCreditApplied,
  offeredCounts,
}: {
  total: number
  customerCreditApplied: number
  offeredCounts: readonly InstallmentCount[]
}): InstallmentsRoundedCheckoutTotal {
  const totalCents = toCents(total)
  const requestedCreditCents = Math.min(toCents(customerCreditApplied), totalCents)

  if (requestedCreditCents >= totalCents) {
    return {
      total: totalCents / 100,
      externalAmountDue: 0,
      customerCreditApplied: requestedCreditCents / 100,
      roundingAdjustment: 0,
    }
  }

  const divisor = getInstallmentCountsDivisor(offeredCounts)
  const roundedTotalCents = Math.ceil(totalCents / divisor) * divisor
  const creditCents = Math.floor(requestedCreditCents / divisor) * divisor

  return {
    total: roundedTotalCents / 100,
    externalAmountDue: (roundedTotalCents - creditCents) / 100,
    customerCreditApplied: creditCents / 100,
    roundingAdjustment: (roundedTotalCents - totalCents) / 100,
  }
}

function toCents(amount: number): number {
  return Number.isFinite(amount) ? Math.max(Math.round(amount * 100), 0) : 0
}

/**
 * Monto de cada cuota: división EXACTA, sin redondear, del total canónico
 * (`getFinancedPrice` o `roundUpCheckoutTotalForInstallments`, que ya
 * garantizan divisibilidad al centavo). Nunca se ajusta una cuota para que
 * cierre: si el total no divide, el error está en el total, no acá. Única
 * excepción: con cuotas sin recargo el total es el contado tal cual (sin
 * redondeo, para no cobrar ni un centavo más) y la cuota puede tener
 * fracción de centavo; Mercado Pago define el importe final de cada cuota.
 */
export function getInstallmentAmount(
  financedPrice: number,
  count: InstallmentCount,
): number | null {
  if (!Number.isFinite(financedPrice) || financedPrice <= 0) return null

  return toCents(financedPrice) / count / 100
}

export interface InstallmentPlan {
  count: InstallmentCount
  amount: number
}

export interface CartFinanceableLine {
  cashPrice: number
  /** Cuota cuyo costo se usa para el gross-up de la línea (en checkout: el TIER confirmado por Mercado Pago). */
  maxEligibleCount: InstallmentCount | null
  quantity: number
  /** Regla del producto "Mismo precio en contado y cuotas": la línea aporta su contado. */
  withoutSurcharge?: boolean
}

/**
 * Total financiado del CARRITO: suma de los precios financiados
 * INDIVIDUALES de cada línea (cada uno calculado con SU propio máximo de
 * cuotas), nunca recalculado con la tasa del mínimo común del carrito. El
 * mínimo común (`getCartInstallmentEligibility`) sólo limita qué cantidades
 * de cuotas se OFRECEN al cliente para pagar este mismo total -- nunca
 * cambia el total en sí. Una línea sin ninguna cuota habilitada aporta su
 * precio de contado (no hay financiado que calcular), igual que una línea
 * con cuotas sin recargo.
 */
export function getCartFinancedTotal(
  lines: CartFinanceableLine[],
  config: InstallmentsFinancingConfig,
): number {
  return lines.reduce((total, line) => {
    const financedPrice = line.withoutSurcharge
      ? null
      : getFinancedPrice(line.cashPrice, line.maxEligibleCount, config)
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
