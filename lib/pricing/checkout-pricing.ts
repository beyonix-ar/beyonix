/**
 * Cálculo canónico del checkout con Mercado Pago -- ÚNICA implementación,
 * compartida por el servidor (`/api/mercadopago/create-preference`, fuente de
 * verdad que decide lo que se cobra) y por la UI del checkout (sólo
 * informativa). Antes cada lado replicaba el cálculo por su cuenta.
 *
 * Mercado Pago tiene exactamente dos modalidades:
 *
 * - `cash` (1 pago, con crédito, débito o dinero en cuenta): se cobra el
 *   total de CONTADO y la preferencia se crea con `installments = 1`.
 * - `financed` (cuotas sin interés): se cobra el total FINANCIADO calculado
 *   con el costo del TIER (la cuota sin interés más alta que Mercado Pago
 *   confirma para ese monto, ver `resolveFinancingTier`) y la preferencia
 *   permite hasta ese tier. El cliente elige la cuota antes de Mercado Pago;
 *   cualquier cuota dentro del tier cobra el mismo total.
 *
 * Módulo puro (sin I/O ni `node:crypto`): el hash de
 * `buildCheckoutEconomicState` vive en `lib/mercadopago/checkout-attempt.ts`.
 */

import { calculateCartTotals } from "../cart/cart-totals.ts"
import {
  calculateCustomerCreditApplication,
  roundMoney,
} from "../customer-credit.ts"
import { getProductDiscount } from "../store-config.ts"
import { calculateStoreBenefitDiscount } from "../customer-store-benefits.ts"
import {
  getCartInstallmentEligibility,
  getEffectiveInstallmentPercent,
  type EligibleInstallmentsProduct,
  type InstallmentCount,
  type InstallmentsFinancingConfig,
} from "../products/installments.ts"
import {
  calculateCftea,
  getCartFinancedTotal,
  getInstallmentAmount,
  getMaxEligibleInstallmentCount,
  getPriceWithoutNationalTaxes,
  getProductFinancedPriceForCount,
  getTransferPrice,
  hasInstallmentsWithoutSurcharge,
  resolveFinancingTier,
  roundUpCheckoutTotalForInstallments,
  type FinancingTierCandidate,
  type InterestFreeLookup,
} from "./financed-pricing.ts"

export const MERCADOPAGO_CHECKOUT_MODES = ["cash", "financed"] as const
export type MercadoPagoCheckoutMode = (typeof MERCADOPAGO_CHECKOUT_MODES)[number]

/** Valor persistido en `pricing_snapshot.mercadoPagoModality`. */
export type MercadoPagoPaymentModality = "mercadopago_cash" | "mercadopago_financed"

export function getMercadoPagoPaymentModality(
  mode: MercadoPagoCheckoutMode,
): MercadoPagoPaymentModality {
  return mode === "financed" ? "mercadopago_financed" : "mercadopago_cash"
}

/**
 * Nunca confía en el valor crudo del navegador: cualquier cosa que no sea
 * exactamente "financed" es contado. `legacyInstallmentsModality` mantiene
 * compatibilidad con un cliente viejo (pestaña abierta antes del deploy) que
 * todavía manda la cuota elegida (2/3/6): cualquier cuota válida significa
 * "en cuotas" -- el tope real lo decide siempre el servidor.
 */
export function normalizeMercadoPagoCheckoutMode(
  value: unknown,
  legacyInstallmentsModality?: unknown,
): MercadoPagoCheckoutMode {
  if (value === "financed") return "financed"
  if (value === "cash") return "cash"

  const legacyCount = Number(legacyInstallmentsModality)
  return legacyCount === 2 || legacyCount === 3 || legacyCount === 6
    ? "financed"
    : "cash"
}

export interface CheckoutPricingLine {
  productId: number
  variantId: number | null
  conditionedStockId: string | null
  quantity: number
  /** Precio de contado unitario vigente (producto/variante/condicionado). */
  unitPrice: number
  /** Flags de cuotas del producto (`cuotas_N_habilitadas`, `cuotas_sin_recargo`). */
  installments: EligibleInstallmentsProduct
}

/**
 * Regla de precio en cuotas usada por el carrito (queda en el snapshot de la
 * orden): `surcharge` = todas las líneas financiadas con recargo,
 * `without_surcharge` = todas al precio de contado, `mixed` = combinación.
 */
export type InstallmentsPricingRule = "surcharge" | "without_surcharge" | "mixed"

export function getInstallmentsPricingRule(
  lines: CheckoutPricingLine[],
): InstallmentsPricingRule {
  const withoutSurcharge = lines.filter((line) =>
    hasInstallmentsWithoutSurcharge(line.installments),
  ).length
  if (withoutSurcharge === 0) return "surcharge"
  return withoutSurcharge === lines.length ? "without_surcharge" : "mixed"
}

/** Productos del carrito con "Mismo precio en contado y cuotas", ordenados y sin repetir. */
export function getInstallmentsWithoutSurchargeProductIds(
  lines: CheckoutPricingLine[],
): number[] {
  return [
    ...new Set(
      lines
        .filter((line) => hasInstallmentsWithoutSurcharge(line.installments))
        .map((line) => line.productId),
    ),
  ].sort((left, right) => left - right)
}

export interface CheckoutPricingSettings {
  installmentsFinancing: InstallmentsFinancingConfig
  transferDiscountPercent: number
  nationalTaxesIncidencePercent: number
}

export interface MercadoPagoCheckoutPricingInput {
  lines: CheckoutPricingLine[]
  /** Envío efectivamente cobrado al cliente (ya bonificado). Nunca lleva recargo por financiación. */
  shippingCharged: number
  storeBenefitPercent: number | null
  /** Saldo a favor pedido por el cliente. La disponibilidad real se valida aparte, server-side. */
  requestedCustomerCredit: number
  settings: CheckoutPricingSettings
  /**
   * Cuotas que Mercado Pago confirma SIN INTERÉS para cada monto candidato
   * (lib/mercadopago/interest-free-installments.ts). Define el TIER de
   * financiación (ver `resolveFinancingTier`). `null` = sin confirmación
   * (todavía no consultado o error): sólo 1 pago a precio contado.
   */
  interestFreeLookup: InterestFreeLookup | null
}

export interface MercadoPagoModeQuote {
  mode: MercadoPagoCheckoutMode
  modality: MercadoPagoPaymentModality
  /** Total de la orden antes de saldo a favor (con ajuste de redondeo de cuotas si corresponde). */
  total: number
  /** Lo que se cobra por Mercado Pago: `total - customerCreditApplied`. */
  externalAmountDue: number
  customerCreditApplied: number
  roundingAdjustment: number
  /** `payment_methods.installments` de la preferencia: 1 al contado, cuota máxima elegible en cuotas. */
  preferenceMaxInstallments: number
  /** El saldo pedido supera el total de esta modalidad: el cliente debe revisar antes de pagar. */
  requestedCreditExceedsTotal: boolean
}

export interface CheckoutInstallmentPlan {
  count: InstallmentCount
  /** Valor de cada cuota sobre lo que efectivamente se cobra (neto de saldo). Informativo. */
  amount: number
  /** CFTEA (%) del plan sobre el total financiado antes de saldo -- disclosure legal. */
  cfteaPercent: number | null
}

export interface MercadoPagoCheckoutPricing {
  productsTotal: number
  /** Beneficio de tienda sobre el total de CONTADO de productos. */
  storeBenefitDiscountAmount: number
  /** Mismo beneficio aplicado sobre los productos FINANCIADOS (el que usa `financedTotal`). */
  financedStoreBenefitDiscountAmount: number
  shippingCharged: number
  /** Productos netos + envío, a precio de contado. */
  cashTotal: number
  /**
   * Productos financiados netos + envío (calculado con el costo del TIER),
   * antes del redondeo final. `null` sin cuotas sin interés confirmadas.
   */
  financedTotal: number | null
  cartInstallmentEligibility: InstallmentCount[]
  /** Cuota máxima que ADMITEN los productos (configuración; nunca define el precio por sí sola). */
  maxInstallmentCount: InstallmentCount | null
  /** Cuotas que se ofrecen: elegibles, <= tier y confirmadas sin interés por Mercado Pago. */
  interestFreeInstallmentCounts: InstallmentCount[]
  /** TIER: cuota sin interés más alta confirmada; su costo define el precio financiado (`null`: sólo 1 pago). */
  offeredInstallmentCount: InstallmentCount | null
  installmentsPricingRule: InstallmentsPricingRule
  installmentsWithoutSurchargeProductIds: number[]
  cash: MercadoPagoModeQuote
  financed: MercadoPagoModeQuote | null
  installmentPlans: CheckoutInstallmentPlan[]
}

function exceedsRequestedCredit(appliedAmount: number, requested: number) {
  return Math.abs(appliedAmount - roundMoney(Math.max(requested, 0))) > 0.009
}

/**
 * Precio de contado unitario efectivo: el mismo descuento por evento que ya
 * aplica `calculateCartTotals` (store-config), así contado y financiado
 * parten del mismo precio rebajado.
 */
function getEffectiveUnitPrice(line: CheckoutPricingLine) {
  const price = Number.isFinite(line.unitPrice) ? Math.max(line.unitPrice, 0) : 0
  return price * (1 - getProductDiscount(line.productId))
}

function sumCashProducts(lines: CheckoutPricingLine[]) {
  return roundMoney(
    calculateCartTotals(
      lines.map((line) => ({
        product: { id: line.productId, precio: line.unitPrice },
        quantity: Math.max(0, line.quantity),
        unitPrice: line.unitPrice,
      })),
    ).productsTotal,
  )
}

interface FinancingTierQuote {
  count: InstallmentCount
  financedTotal: number
  financedStoreBenefitDiscountAmount: number
  quote: MercadoPagoModeQuote
}

/**
 * Cotización financiada de UN tier: todas las líneas con el costo de `tier`
 * cuotas (el tier está en la intersección del carrito, así que todas lo
 * admiten); las líneas "Mismo precio en contado y cuotas" aportan su contado.
 * El redondeo usa las cuotas elegibles <= tier. Nunca depende de cuál de
 * esas cuotas elija el cliente.
 */
function buildFinancingTierQuote(
  input: Omit<MercadoPagoCheckoutPricingInput, "interestFreeLookup">,
  context: { cashTotal: number; storeBenefitDiscountAmount: number; shipping: number; sameAsCash: boolean; eligibility: InstallmentCount[] },
  tier: InstallmentCount,
): FinancingTierQuote | null {
  const rawFinancedProducts = getCartFinancedTotal(
    input.lines.map((line) => ({
      cashPrice: getEffectiveUnitPrice(line),
      maxEligibleCount: tier,
      quantity: line.quantity,
      withoutSurcharge: hasInstallmentsWithoutSurcharge(line.installments),
    })),
    input.settings.installmentsFinancing,
  )
  if (rawFinancedProducts <= 0) return null

  const financedStoreBenefitDiscountAmount = context.sameAsCash
    ? context.storeBenefitDiscountAmount
    : calculateStoreBenefitDiscount(rawFinancedProducts, input.storeBenefitPercent)
  const financedTotal = context.sameAsCash
    ? context.cashTotal
    : roundMoney(Math.max(rawFinancedProducts - financedStoreBenefitDiscountAmount, 0) + context.shipping)
  const financedCredit = calculateCustomerCreditApplication({
    availableBalance: input.requestedCustomerCredit,
    eligibleTotal: financedTotal,
    requestedAmount: input.requestedCustomerCredit,
  })
  // Sin recargo no se redondea: cobrar un centavo más ya no sería "mismo precio".
  const rounded = context.sameAsCash
    ? {
        total: financedTotal,
        externalAmountDue: financedCredit.externalAmountDue,
        customerCreditApplied: financedCredit.appliedAmount,
        roundingAdjustment: 0,
      }
    : roundUpCheckoutTotalForInstallments({
        total: financedTotal,
        customerCreditApplied: financedCredit.appliedAmount,
        offeredCounts: context.eligibility.filter((count) => count <= tier),
      })

  return {
    count: tier,
    financedTotal,
    financedStoreBenefitDiscountAmount,
    quote: {
      mode: "financed",
      modality: getMercadoPagoPaymentModality("financed"),
      total: rounded.total,
      externalAmountDue: rounded.externalAmountDue,
      customerCreditApplied: rounded.customerCreditApplied,
      roundingAdjustment: rounded.roundingAdjustment,
      preferenceMaxInstallments: tier,
      requestedCreditExceedsTotal: exceedsRequestedCredit(
        financedCredit.appliedAmount,
        input.requestedCustomerCredit,
      ),
    },
  }
}

function getCheckoutPricingContext(input: Omit<MercadoPagoCheckoutPricingInput, "interestFreeLookup">) {
  const shipping = roundMoney(Math.max(input.shippingCharged, 0))
  const productsTotal = sumCashProducts(input.lines)
  const storeBenefitDiscountAmount = calculateStoreBenefitDiscount(
    productsTotal,
    input.storeBenefitPercent,
  )
  const cashTotal = roundMoney(Math.max(productsTotal - storeBenefitDiscountAmount, 0) + shipping)
  const eligibility = getCartInstallmentEligibility(input.lines.map((line) => line.installments))
  const installmentsPricingRule = getInstallmentsPricingRule(input.lines)
  return {
    shipping,
    productsTotal,
    storeBenefitDiscountAmount,
    cashTotal,
    eligibility,
    installmentsPricingRule,
    // Todo el carrito sin recargo: en cuotas se cobra EXACTAMENTE el contado.
    sameAsCash: installmentsPricingRule === "without_surcharge",
  }
}

/**
 * Montos que hay que consultar a Mercado Pago: lo que se cobraría (neto de
 * saldo) en cada tier posible del carrito. Mismo cálculo que el checkout.
 */
export function getMercadoPagoFinancingCandidates(
  input: Omit<MercadoPagoCheckoutPricingInput, "interestFreeLookup">,
): FinancingTierCandidate[] {
  const context = getCheckoutPricingContext(input)
  return context.eligibility.flatMap((count) => {
    const tier = buildFinancingTierQuote(input, context, count)
    return tier ? [{ count, amount: tier.quote.externalAmountDue }] : []
  })
}

/**
 * Regla de negocio:
 * - 1 pago (cualquier medio): precio CONTADO.
 * - Cuotas: precio financiado con el costo del TIER = la cuota sin interés
 *   más alta que Mercado Pago confirma para ese monto (2/3 -> costo de 3;
 *   2/3/6 -> costo de 6). Elegir menos cuotas dentro del tier no baja el
 *   precio. La configuración del producto sólo limita qué cuotas admite.
 * - Sin confirmación (o error): no hay cuotas; sólo 1 pago a contado.
 */
export function calculateMercadoPagoCheckoutPricing(
  input: MercadoPagoCheckoutPricingInput,
): MercadoPagoCheckoutPricing {
  const { lines, requestedCustomerCredit, interestFreeLookup } = input
  const context = getCheckoutPricingContext(input)
  const {
    shipping,
    productsTotal,
    storeBenefitDiscountAmount,
    cashTotal,
    eligibility: cartInstallmentEligibility,
    installmentsPricingRule,
  } = context
  const maxInstallmentCount: InstallmentCount | null =
    cartInstallmentEligibility[cartInstallmentEligibility.length - 1] ?? null

  const tiers = new Map<InstallmentCount, FinancingTierQuote>()
  for (const count of cartInstallmentEligibility) {
    const tier = buildFinancingTierQuote(input, context, count)
    if (tier) tiers.set(count, tier)
  }
  const resolved = resolveFinancingTier(
    [...tiers.values()].map((tier) => ({ count: tier.count, amount: tier.quote.externalAmountDue })),
    cartInstallmentEligibility,
    interestFreeLookup,
  )
  const chosen = resolved ? tiers.get(resolved.tier.count) ?? null : null
  const interestFreeInstallmentCounts = resolved?.offeredCounts ?? []
  const offeredInstallmentCount = chosen?.count ?? null
  const financedTotal = chosen?.financedTotal ?? null
  const financedStoreBenefitDiscountAmount =
    chosen?.financedStoreBenefitDiscountAmount ?? storeBenefitDiscountAmount

  const cashCredit = calculateCustomerCreditApplication({
    availableBalance: requestedCustomerCredit,
    eligibleTotal: cashTotal,
    requestedAmount: requestedCustomerCredit,
  })
  const cash: MercadoPagoModeQuote = {
    mode: "cash",
    modality: getMercadoPagoPaymentModality("cash"),
    total: cashTotal,
    externalAmountDue: cashCredit.externalAmountDue,
    customerCreditApplied: cashCredit.appliedAmount,
    roundingAdjustment: 0,
    preferenceMaxInstallments: 1,
    requestedCreditExceedsTotal: exceedsRequestedCredit(
      cashCredit.appliedAmount,
      requestedCustomerCredit,
    ),
  }

  const financed: MercadoPagoModeQuote | null = chosen?.quote ?? null
  let installmentPlans: CheckoutInstallmentPlan[] = []

  if (financed) {
    // CFTEA sobre el total financiado final ANTES de saldo (describe el
    // producto financiero, no un residuo que depende del saldo), contra el
    // contado. Fórmula sin cambios (calculateCftea).
    installmentPlans = interestFreeInstallmentCounts.flatMap((count) => {
      const amount = getInstallmentAmount(financed.externalAmountDue, count)
      if (amount == null) return []
      const legalAmount = getInstallmentAmount(financed.total, count)
      return [
        {
          count,
          amount,
          cfteaPercent:
            legalAmount != null && cashTotal > 0
              ? calculateCftea(cashTotal, legalAmount, count)
              : null,
        },
      ]
    })
  }

  return {
    productsTotal,
    storeBenefitDiscountAmount,
    financedStoreBenefitDiscountAmount,
    shippingCharged: shipping,
    cashTotal,
    financedTotal,
    cartInstallmentEligibility,
    maxInstallmentCount,
    interestFreeInstallmentCounts,
    offeredInstallmentCount,
    installmentsPricingRule,
    installmentsWithoutSurchargeProductIds:
      getInstallmentsWithoutSurchargeProductIds(lines),
    cash,
    financed,
    installmentPlans,
  }
}

/**
 * Filas del "Resumen del pedido" (sólo presentación): Productos − Beneficio
 * + Envío = Total, EXACTO, con los mismos valores canónicos que se cobran.
 *
 * - Al contado: productos a precio de contado.
 * - En cuotas: productos a precio FINANCIADO (suma de los financiados
 *   canónicos de cada línea, `getCartFinancedTotal`) incluyendo el ajuste
 *   de redondeo de cuotas, que pertenece al monto financiado. El envío
 *   nunca se financia: se muestra (y se cobra) a su costo real.
 *
 * El total es antes de saldo a favor (el saldo se muestra aparte).
 */
export interface CheckoutSummaryBreakdown {
  productsSubtotal: number
  storeBenefitDiscount: number
  shipping: number
  total: number
}

export function getMercadoPagoSummaryBreakdown(
  pricing: MercadoPagoCheckoutPricing,
  mode: MercadoPagoCheckoutMode,
): CheckoutSummaryBreakdown {
  const financed = mode === "financed" ? pricing.financed : null

  if (!financed) {
    return {
      productsSubtotal: pricing.productsTotal,
      storeBenefitDiscount: pricing.storeBenefitDiscountAmount,
      shipping: pricing.shippingCharged,
      total: pricing.cash.total,
    }
  }

  return {
    productsSubtotal: roundMoney(
      financed.total - pricing.shippingCharged + pricing.financedStoreBenefitDiscountAmount,
    ),
    storeBenefitDiscount: pricing.financedStoreBenefitDiscountAmount,
    shipping: pricing.shippingCharged,
    total: financed.total,
  }
}

/**
 * Reparte `targetTotal` (pesos) entre líneas en proporción a `weights`,
 * trabajando en centavos enteros (método del mayor resto): la suma de las
 * partes es EXACTAMENTE `targetTotal`. Si los pesos ya suman el objetivo,
 * cada línea recibe su propio valor sin cambios.
 */
export function allocateAmountAcrossLines(weights: number[], targetTotal: number): number[] {
  const weightCents = weights.map((weight) =>
    Number.isFinite(weight) ? Math.max(Math.round(weight * 100), 0) : 0,
  )
  const targetCents = Number.isFinite(targetTotal) ? Math.max(Math.round(targetTotal * 100), 0) : 0
  const totalWeight = weightCents.reduce((sum, weight) => sum + weight, 0)

  if (weights.length === 0) return []
  if (totalWeight === 0) {
    return weights.map((_, index) => (index === 0 ? targetCents / 100 : 0))
  }

  const exactShares = weightCents.map((weight) => (targetCents * weight) / totalWeight)
  const allocated = exactShares.map((share) => Math.floor(share))
  let leftover = targetCents - allocated.reduce((sum, value) => sum + value, 0)
  const byRemainder = exactShares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)

  for (const { index } of byRemainder) {
    if (leftover <= 0) break
    allocated[index] += 1
    leftover -= 1
  }

  return allocated.map((cents) => cents / 100)
}

export type CheckoutSummaryMode = "cash" | "financed" | "transfer"

/**
 * Importe de cada línea del resumen según la modalidad elegida (sólo
 * presentación; nunca toca el precio real del producto):
 * - contado: precio de contado de la línea;
 * - cuotas: precio financiado de la línea con el costo del TIER (el mismo
 *   que usa el total, `financingCount`) o su contado si es sin recargo; el
 *   ajuste de redondeo de cuotas (centavos) se reparte entre las líneas;
 * - transferencia: el descuento canónico (calculado sobre el total de
 *   productos) se reparte en proporción al precio de contado de cada línea.
 * Las líneas suman EXACTAMENTE `productsSubtotal` (la fila "Productos").
 */
export function getCheckoutSummaryLineAmounts({
  lines,
  mode,
  installmentsFinancing,
  financingCount,
  productsSubtotal,
}: {
  lines: CheckoutPricingLine[]
  mode: CheckoutSummaryMode
  installmentsFinancing: InstallmentsFinancingConfig
  /** Tier de la cotización financiada (`pricing.offeredInstallmentCount`). */
  financingCount: InstallmentCount | null
  productsSubtotal: number
}): number[] {
  const weights = lines.map((line) => {
    const cashUnit = getEffectiveUnitPrice(line)
    const quantity = Math.max(0, line.quantity)
    if (mode !== "financed" || financingCount == null) return cashUnit * quantity

    const financedUnit = getProductFinancedPriceForCount(
      line.installments,
      cashUnit,
      financingCount,
      installmentsFinancing,
    )
    return (financedUnit ?? cashUnit) * quantity
  })

  // Carrito mixto: el ajuste de redondeo de cuotas es de las líneas CON
  // recargo; una línea sin recargo muestra siempre su contado exacto.
  const withoutSurcharge = lines.map((line) =>
    mode === "financed" && hasInstallmentsWithoutSurcharge(line.installments),
  )
  if (!withoutSurcharge.some(Boolean) || withoutSurcharge.every(Boolean)) {
    return allocateAmountAcrossLines(weights, productsSubtotal)
  }

  const fixedAmounts = weights.map((weight, index) =>
    withoutSurcharge[index] ? roundMoney(weight) : 0,
  )
  const fixedTotal = fixedAmounts.reduce((sum, amount) => sum + amount, 0)
  const surchargeIndexes = weights.flatMap((_, index) => (withoutSurcharge[index] ? [] : [index]))
  const surchargeAmounts = allocateAmountAcrossLines(
    surchargeIndexes.map((index) => weights[index]),
    roundMoney(productsSubtotal - fixedTotal),
  )

  return fixedAmounts.map((amount, index) =>
    withoutSurcharge[index] ? amount : surchargeAmounts[surchargeIndexes.indexOf(index)],
  )
}

export function getMercadoPagoModeQuote(
  pricing: MercadoPagoCheckoutPricing,
  mode: MercadoPagoCheckoutMode,
): MercadoPagoModeQuote | null {
  return mode === "financed" ? pricing.financed : pricing.cash
}

// ─────────────────────────────────────────────────────────────
// Snapshot histórico de la orden
// ─────────────────────────────────────────────────────────────

export interface MercadoPagoPricingSnapshotFields {
  cashPriceTotal: number
  transferPriceTotal: number | null
  financedPriceTotal: number | null
  maxInstallmentCount: InstallmentCount | null
  transferDiscountPercent: number
  nationalTaxesIncidencePercent: number
  cftea: { monthlyRate: number; annualPercent: number } | null
  installmentsRoundingAdjustment: number
  priceWithoutNationalTaxes: { cash: number; financed: number | null }
  mercadoPagoModality: MercadoPagoPaymentModality
  finalTotal: number
  externalAmountDue: number
  customerCreditApplied: number
  preferenceMaxInstallments: number
  /** Cuotas que Mercado Pago confirmó sin interés al crear la orden (histórico). */
  interestFreeInstallmentCounts: InstallmentCount[]
  /** Tier cuyo costo definió el precio financiado (`null` en 1 pago). */
  financingTier: InstallmentCount | null
  /** Cuota que eligió el cliente en BEYONIX (`null` en 1 pago). Preselección en Mercado Pago. */
  selectedInstallmentCount: InstallmentCount | null
  cfteaByCount: Partial<Record<InstallmentCount, number>> | null
  installmentsFinancing: InstallmentsFinancingConfig
  /** Regla de cuotas vigente al comprar ("Mismo precio en contado y cuotas" por producto). */
  installmentsPricingRule: InstallmentsPricingRule
  installmentsWithoutSurchargeProductIds: number[]
  economicFingerprint: string
}

/**
 * Snapshot completo para reconstruir históricamente la operación. Los campos
 * previos conservan su significado; los nuevos son aditivos (JSON, sin
 * migración) y los pedidos viejos simplemente no los tienen.
 */
export function buildMercadoPagoPricingSnapshot({
  pricing,
  mode,
  settings,
  economicFingerprint,
  selectedInstallmentCount = null,
}: {
  pricing: MercadoPagoCheckoutPricing
  mode: MercadoPagoCheckoutMode
  settings: CheckoutPricingSettings
  economicFingerprint: string
  selectedInstallmentCount?: InstallmentCount | null
}): MercadoPagoPricingSnapshotFields {
  const quote = getMercadoPagoModeQuote(pricing, mode) ?? pricing.cash
  const isFinanced = quote.mode === "financed"
  const maxCount = pricing.maxInstallmentCount
  // CFTEA de la cuota máxima realmente OFRECIDA (confirmada sin interés).
  const maxPlan = pricing.installmentPlans.find(
    (plan) => plan.count === pricing.offeredInstallmentCount,
  )
  const cfteaByCount = isFinanced
    ? Object.fromEntries(
        pricing.installmentPlans.flatMap((plan) =>
          plan.cfteaPercent != null ? [[plan.count, plan.cfteaPercent]] : [],
        ),
      )
    : null

  return {
    cashPriceTotal: pricing.cashTotal,
    transferPriceTotal: getTransferPrice(
      pricing.cashTotal,
      settings.transferDiscountPercent,
    ),
    financedPriceTotal: pricing.financedTotal,
    maxInstallmentCount: maxCount,
    transferDiscountPercent: settings.transferDiscountPercent,
    nationalTaxesIncidencePercent: settings.nationalTaxesIncidencePercent,
    // Al contado no hay financiación: nunca hay CFTEA.
    cftea:
      isFinanced && maxPlan?.cfteaPercent != null
        ? {
            monthlyRate: Math.pow(1 + maxPlan.cfteaPercent / 100, 1 / 12) - 1,
            annualPercent: maxPlan.cfteaPercent,
          }
        : null,
    installmentsRoundingAdjustment: quote.roundingAdjustment,
    priceWithoutNationalTaxes: {
      cash: getPriceWithoutNationalTaxes(
        pricing.cashTotal,
        settings.nationalTaxesIncidencePercent,
      ),
      financed:
        pricing.financedTotal != null
          ? getPriceWithoutNationalTaxes(
              pricing.financedTotal,
              settings.nationalTaxesIncidencePercent,
            )
          : null,
    },
    mercadoPagoModality: quote.modality,
    finalTotal: quote.total,
    externalAmountDue: quote.externalAmountDue,
    customerCreditApplied: quote.customerCreditApplied,
    preferenceMaxInstallments: quote.preferenceMaxInstallments,
    interestFreeInstallmentCounts: isFinanced ? pricing.interestFreeInstallmentCounts : [],
    financingTier: isFinanced ? pricing.offeredInstallmentCount : null,
    selectedInstallmentCount: isFinanced ? selectedInstallmentCount : null,
    cfteaByCount,
    installmentsFinancing: settings.installmentsFinancing,
    installmentsPricingRule: pricing.installmentsPricingRule,
    installmentsWithoutSurchargeProductIds:
      pricing.installmentsWithoutSurchargeProductIds,
    economicFingerprint,
  }
}

/**
 * Datos de cuotas persistidos en columnas de `ordenes` para una orden
 * financiada. `count` queda `null`: con la modalidad "en cuotas" el cliente
 * elige la cantidad final dentro de Checkout Pro (queda en
 * `mercadopago_payment_snapshot.installments` al aprobarse el pago).
 */
export function getMercadoPagoOrderInstallmentsFields(
  pricing: MercadoPagoCheckoutPricing,
  mode: MercadoPagoCheckoutMode,
  installmentsFinancing: InstallmentsFinancingConfig,
) {
  // El costo y el máximo son los del TIER (lo que habilitó Mercado Pago),
  // nunca la cuota máxima configurada del producto.
  const tier = pricing.offeredInstallmentCount
  if (mode !== "financed" || pricing.financedTotal == null || tier == null) {
    return null
  }

  return {
    count: null,
    percent: getEffectiveInstallmentPercent(tier, installmentsFinancing),
    productsBaseAmount: pricing.cashTotal,
    surchargeAmount: roundMoney(pricing.financedTotal - pricing.cashTotal),
    maxEligibleCount: tier,
  }
}

// ─────────────────────────────────────────────────────────────
// Preferencia de Mercado Pago
// ─────────────────────────────────────────────────────────────

export interface MercadoPagoPreferenceInstallmentsSource {
  installments_count?: number | null
  pricing_snapshot?: {
    mercadoPagoModality?: string | null
    preferenceMaxInstallments?: number | null
    selectedInstallmentCount?: number | null
  } | null
}

export type MercadoPagoExcludedPaymentType = {
  id: "credit_card" | "debit_card" | "prepaid_card" | "ticket" | "atm"
}

export type MercadoPagoPreferencePaymentMethods = {
  installments: number
  default_installments?: number
  excluded_payment_types?: MercadoPagoExcludedPaymentType[]
}

/**
 * Tipos de pago excluidos por modalidad (Checkout Pro, `payment_methods.
 * excluded_payment_types`):
 *
 * - 1 pago (precio contado): crédito, débito, prepaga o dinero en cuenta, en
 *   1 pago. Fuera sólo los medios diferidos en efectivo (Rapipago/Pago
 *   Fácil = `ticket`, cajeros/Red Link = `atm`).
 * - Cuotas sin interés (precio financiado del tier): sólo tarjeta de crédito,
 *   hasta el tier. Fuera débito, prepaga y los medios diferidos.
 *
 * "Dinero en cuenta" (`account_money`) NO se excluye: Mercado Pago no lo
 * permite en Checkout Pro ("El medio de pago Dinero en cuenta no puede ser
 * excluido"), por eso puede seguir apareciendo en ambas modalidades. El monto
 * de la preferencia es fijo: con cualquier medio se cobra el total de la
 * modalidad elegida.
 */
export const MERCADOPAGO_CASH_EXCLUDED_PAYMENT_TYPES: MercadoPagoExcludedPaymentType[] = [
  { id: "ticket" },
  { id: "atm" },
]
export const MERCADOPAGO_CREDIT_EXCLUDED_PAYMENT_TYPES: MercadoPagoExcludedPaymentType[] = [
  { id: "debit_card" },
  { id: "prepaid_card" },
  { id: "ticket" },
  { id: "atm" },
]

/**
 * `payment_methods` de la preferencia, derivado SIEMPRE de lo persistido en
 * la orden (nunca del request): 1 pago => installments=1, cualquier medio
 * salvo los diferidos; cuotas => tope = TIER (Checkout Pro sólo admite un
 * máximo) con la cuota que eligió el cliente preseleccionada, sólo tarjeta de
 * crédito. Órdenes anteriores a este modelo (sin `mercadoPagoModality`)
 * conservan su comportamiento: la cuota elegida como tope y preselección, o
 * 1 pago, sin exclusiones.
 */
export function getMercadoPagoPreferencePaymentMethods(
  order: MercadoPagoPreferenceInstallmentsSource,
): MercadoPagoPreferencePaymentMethods {
  const modality = order.pricing_snapshot?.mercadoPagoModality

  if (modality === "mercadopago_financed") {
    const max = Number(order.pricing_snapshot?.preferenceMaxInstallments)
    const selected = Number(order.pricing_snapshot?.selectedInstallmentCount)
    const excluded_payment_types = [...MERCADOPAGO_CREDIT_EXCLUDED_PAYMENT_TYPES]
    if (max === 2 || max === 3 || max === 6) {
      return [2, 3, 6].includes(selected) && selected <= max
        ? { installments: max, default_installments: selected, excluded_payment_types }
        : { installments: max, excluded_payment_types }
    }
    // Snapshot financiado sin tope válido: nunca se abre a más cuotas de
    // las calculadas -- se degrada a crédito en 1 pago.
    return { installments: 1, default_installments: 1, excluded_payment_types }
  }

  if (modality === "mercadopago_cash") {
    return {
      installments: 1,
      default_installments: 1,
      excluded_payment_types: [...MERCADOPAGO_CASH_EXCLUDED_PAYMENT_TYPES],
    }
  }

  const legacyCount = Number(order.installments_count)
  return legacyCount === 2 || legacyCount === 3 || legacyCount === 6
    ? { installments: legacyCount, default_installments: legacyCount }
    : { installments: 1, default_installments: 1 }
}

// ─────────────────────────────────────────────────────────────
// Estado económico canónico (base del fingerprint)
// ─────────────────────────────────────────────────────────────

export interface CheckoutEconomicShipping {
  provider: string
  type: string
  sucursalId: string | number | null
  costReal: number
  costCharged: number
  freeShippingApplied: boolean
}

function toCents(amount: number | null | undefined) {
  return Number.isFinite(amount) ? Math.round(Number(amount) * 100) : null
}

function toBasisPoints(percent: number) {
  return Number.isFinite(percent) ? Math.round(percent * 100) : null
}

/**
 * Representación determinística de TODO lo que define cuánto se cobra y con
 * qué condiciones: líneas con su precio vigente, envío, beneficio, saldo
 * pedido, modalidad, cuotas y la configuración comercial usada (fees MP,
 * IVA, transferencia, impuestos). Montos en centavos enteros y porcentajes
 * en puntos básicos para que el mismo estado produzca siempre el mismo hash
 * (sin ruido de punto flotante). Si cualquiera de estos valores cambia, el
 * intento de pago previo deja de ser equivalente y no puede reutilizarse.
 */
export function buildCheckoutEconomicState({
  lines,
  shipping,
  storeBenefit,
  requestedCustomerCredit,
  mode,
  pricing,
  settings,
}: {
  lines: CheckoutPricingLine[]
  shipping: CheckoutEconomicShipping
  storeBenefit: { id: string; percent: number } | null
  requestedCustomerCredit: number
  mode: MercadoPagoCheckoutMode
  pricing: MercadoPagoCheckoutPricing
  settings: CheckoutPricingSettings
}) {
  const quote = getMercadoPagoModeQuote(pricing, mode) ?? pricing.cash
  const financing = settings.installmentsFinancing

  return {
    version: 2,
    lines: [...lines]
      .map((line) => ({
        productId: line.productId,
        variantId: line.variantId,
        conditionedStockId: line.conditionedStockId,
        quantity: line.quantity,
        unitPriceCents: toCents(line.unitPrice),
        maxInstallmentCount: getMaxEligibleInstallmentCount(line.installments),
        // Sólo presente cuando aplica (stableStringify omite undefined): los
        // carritos con recargo conservan el mismo fingerprint que antes.
        withoutSurcharge: hasInstallmentsWithoutSurcharge(line.installments)
          ? true
          : undefined,
      }))
      .sort(
        (left, right) =>
          left.productId - right.productId ||
          (left.variantId ?? 0) - (right.variantId ?? 0) ||
          (left.conditionedStockId ?? "").localeCompare(
            right.conditionedStockId ?? "",
          ),
      ),
    shipping: {
      provider: shipping.provider,
      type: shipping.type,
      sucursalId: shipping.sucursalId != null ? String(shipping.sucursalId) : null,
      costRealCents: toCents(shipping.costReal),
      costChargedCents: toCents(shipping.costCharged),
      freeShippingApplied: shipping.freeShippingApplied,
    },
    storeBenefit: storeBenefit
      ? { id: storeBenefit.id, percent: storeBenefit.percent }
      : null,
    requestedCustomerCreditCents: toCents(requestedCustomerCredit),
    mode,
    cartInstallmentEligibility: pricing.cartInstallmentEligibility,
    maxInstallmentCount: pricing.maxInstallmentCount,
    preferenceMaxInstallments: quote.preferenceMaxInstallments,
    settings: {
      baseProcessingBp: toBasisPoints(financing.baseProcessingPercent),
      ivaBp: toBasisPoints(financing.ivaPercent),
      surchargeBpByCount: {
        2: toBasisPoints(financing.surchargePercentByCount[2]),
        3: toBasisPoints(financing.surchargePercentByCount[3]),
        6: toBasisPoints(financing.surchargePercentByCount[6]),
      },
      transferDiscountBp: toBasisPoints(settings.transferDiscountPercent),
      nationalTaxesIncidenceBp: toBasisPoints(settings.nationalTaxesIncidencePercent),
    },
    totals: {
      cashTotalCents: toCents(pricing.cashTotal),
      financedTotalCents: toCents(pricing.financedTotal),
      totalCents: toCents(quote.total),
      externalAmountDueCents: toCents(quote.externalAmountDue),
      customerCreditAppliedCents: toCents(quote.customerCreditApplied),
    },
  }
}

export type CheckoutEconomicState = ReturnType<typeof buildCheckoutEconomicState>

/**
 * JSON canónico: claves de objeto ordenadas en todos los niveles, arrays en
 * su orden (ya normalizado por quien arma el estado). Dos estados iguales
 * producen exactamente el mismo string sin importar el orden de inserción.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`
}
