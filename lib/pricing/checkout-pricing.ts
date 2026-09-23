/**
 * Cálculo canónico del checkout con Mercado Pago -- ÚNICA implementación,
 * compartida por el servidor (`/api/mercadopago/create-preference`, fuente de
 * verdad que decide lo que se cobra) y por la UI del checkout (sólo
 * informativa). Antes cada lado replicaba el cálculo por su cuenta.
 *
 * Mercado Pago tiene exactamente dos modalidades:
 *
 * - `cash` (al contado): se cobra el total de CONTADO y la preferencia se
 *   crea con `payment_methods.installments = 1` -- Checkout Pro no puede
 *   financiar el precio de contado.
 * - `financed` (en cuotas): se cobra el total FINANCIADO (gross-up calculado
 *   con la cuota máxima de cada línea, ver `getCartFinancedTotal`) y la
 *   preferencia permite hasta la cuota máxima elegible del carrito. BEYONIX
 *   no necesita saber cuántas cuotas elige el cliente: el total no cambia.
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
  getFinancedPrice,
  getInstallmentAmount,
  getMaxEligibleInstallmentCount,
  getPriceWithoutNationalTaxes,
  getTransferPrice,
  roundUpCheckoutTotalForInstallments,
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
  /** Flags de cuotas del producto (`cuotas_N_habilitadas`). */
  installments: EligibleInstallmentsProduct
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
  /** Productos financiados netos + envío, antes del redondeo final. `null` si el carrito no admite cuotas. */
  financedTotal: number | null
  cartInstallmentEligibility: InstallmentCount[]
  maxInstallmentCount: InstallmentCount | null
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

export function calculateMercadoPagoCheckoutPricing({
  lines,
  shippingCharged,
  storeBenefitPercent,
  requestedCustomerCredit,
  settings,
}: MercadoPagoCheckoutPricingInput): MercadoPagoCheckoutPricing {
  const shipping = roundMoney(Math.max(shippingCharged, 0))
  const productsTotal = sumCashProducts(lines)
  const storeBenefitDiscountAmount = calculateStoreBenefitDiscount(
    productsTotal,
    storeBenefitPercent,
  )
  const cashTotal = roundMoney(
    Math.max(productsTotal - storeBenefitDiscountAmount, 0) + shipping,
  )

  // Financiado: suma de los financiados INDIVIDUALES de cada línea (cada una
  // con SU máximo de cuotas). El beneficio de tienda es un % uniforme: como
  // el gross-up es lineal, aplicarlo sobre el financiado crudo equivale a
  // aplicarlo línea por línea antes de financiar.
  const rawFinancedProducts = getCartFinancedTotal(
    lines.map((line) => ({
      cashPrice: getEffectiveUnitPrice(line),
      maxEligibleCount: getMaxEligibleInstallmentCount(line.installments),
      quantity: line.quantity,
    })),
    settings.installmentsFinancing,
  )
  const cartInstallmentEligibility = getCartInstallmentEligibility(
    lines.map((line) => line.installments),
  )
  const maxInstallmentCount: InstallmentCount | null =
    cartInstallmentEligibility.length
      ? cartInstallmentEligibility[cartInstallmentEligibility.length - 1]
      : null
  const financedStoreBenefitDiscountAmount = calculateStoreBenefitDiscount(
    rawFinancedProducts,
    storeBenefitPercent,
  )
  const financedTotal =
    rawFinancedProducts > 0 && maxInstallmentCount != null
      ? roundMoney(
          Math.max(rawFinancedProducts - financedStoreBenefitDiscountAmount, 0) +
            shipping,
        )
      : null

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

  let financed: MercadoPagoModeQuote | null = null
  let installmentPlans: CheckoutInstallmentPlan[] = []

  if (financedTotal != null && maxInstallmentCount != null) {
    const financedCredit = calculateCustomerCreditApplication({
      availableBalance: requestedCustomerCredit,
      eligibleTotal: financedTotal,
      requestedAmount: requestedCustomerCredit,
    })
    // Ajuste de redondeo final de cuotas, una única vez, con divisor = cuotas
    // OFRECIDAS al carrito (no la elegida): 2/3/6 cobran el mismo total.
    const rounded = roundUpCheckoutTotalForInstallments({
      total: financedTotal,
      customerCreditApplied: financedCredit.appliedAmount,
      offeredCounts: cartInstallmentEligibility,
    })
    financed = {
      mode: "financed",
      modality: getMercadoPagoPaymentModality("financed"),
      total: rounded.total,
      externalAmountDue: rounded.externalAmountDue,
      customerCreditApplied: rounded.customerCreditApplied,
      roundingAdjustment: rounded.roundingAdjustment,
      preferenceMaxInstallments: maxInstallmentCount,
      requestedCreditExceedsTotal: exceedsRequestedCredit(
        financedCredit.appliedAmount,
        requestedCustomerCredit,
      ),
    }
    // CFTEA sobre el total financiado final ANTES de saldo (describe el
    // producto financiero, no un residuo que depende del saldo), contra el
    // contado. Fórmula sin cambios (calculateCftea).
    installmentPlans = cartInstallmentEligibility.flatMap((count) => {
      const amount = getInstallmentAmount(rounded.externalAmountDue, count)
      if (amount == null) return []
      const legalAmount = getInstallmentAmount(rounded.total, count)
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
 * - cuotas: precio financiado canónico de la línea (`getFinancedPrice` con
 *   SU cuota máxima, igual que `getCartFinancedTotal`); el ajuste de
 *   redondeo de cuotas (centavos) se reparte entre las líneas;
 * - transferencia: el descuento canónico (calculado sobre el total de
 *   productos) se reparte en proporción al precio de contado de cada línea.
 * Las líneas suman EXACTAMENTE `productsSubtotal` (la fila "Productos").
 */
export function getCheckoutSummaryLineAmounts({
  lines,
  mode,
  installmentsFinancing,
  productsSubtotal,
}: {
  lines: CheckoutPricingLine[]
  mode: CheckoutSummaryMode
  installmentsFinancing: InstallmentsFinancingConfig
  productsSubtotal: number
}): number[] {
  const weights = lines.map((line) => {
    const cashUnit = getEffectiveUnitPrice(line)
    const quantity = Math.max(0, line.quantity)
    if (mode !== "financed") return cashUnit * quantity

    const financedUnit = getFinancedPrice(
      cashUnit,
      getMaxEligibleInstallmentCount(line.installments),
      installmentsFinancing,
    )
    return (financedUnit ?? cashUnit) * quantity
  })

  return allocateAmountAcrossLines(weights, productsSubtotal)
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
  cfteaByCount: Partial<Record<InstallmentCount, number>> | null
  installmentsFinancing: InstallmentsFinancingConfig
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
}: {
  pricing: MercadoPagoCheckoutPricing
  mode: MercadoPagoCheckoutMode
  settings: CheckoutPricingSettings
  economicFingerprint: string
}): MercadoPagoPricingSnapshotFields {
  const quote = getMercadoPagoModeQuote(pricing, mode) ?? pricing.cash
  const isFinanced = quote.mode === "financed"
  const maxCount = pricing.maxInstallmentCount
  const maxPlan = pricing.installmentPlans.find((plan) => plan.count === maxCount)
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
    cfteaByCount,
    installmentsFinancing: settings.installmentsFinancing,
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
  if (
    mode !== "financed" ||
    pricing.financedTotal == null ||
    pricing.maxInstallmentCount == null
  ) {
    return null
  }

  return {
    count: null,
    percent: getEffectiveInstallmentPercent(
      pricing.maxInstallmentCount,
      installmentsFinancing,
    ),
    productsBaseAmount: pricing.cashTotal,
    surchargeAmount: roundMoney(pricing.financedTotal - pricing.cashTotal),
    maxEligibleCount: pricing.maxInstallmentCount,
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
  } | null
}

/**
 * `payment_methods` de la preferencia, derivado SIEMPRE de lo persistido en
 * la orden (nunca del request): contado => installments=1 (Checkout Pro no
 * ofrece cuotas); en cuotas => tope = cuota máxima elegible y el cliente
 * elige dentro de Mercado Pago. Órdenes anteriores a este modelo (sin
 * `mercadoPagoModality`) conservan su comportamiento: la cuota elegida como
 * tope y preselección, o 1 pago.
 */
export function getMercadoPagoPreferenceInstallments(
  order: MercadoPagoPreferenceInstallmentsSource,
): { installments: number; default_installments?: number } {
  const modality = order.pricing_snapshot?.mercadoPagoModality

  if (modality === "mercadopago_financed") {
    const max = Number(order.pricing_snapshot?.preferenceMaxInstallments)
    if (max === 2 || max === 3 || max === 6) return { installments: max }
    // Snapshot financiado sin tope válido: nunca se abre a más cuotas de
    // las calculadas -- se degrada a 1 pago.
    return { installments: 1, default_installments: 1 }
  }

  if (modality === "mercadopago_cash") {
    return { installments: 1, default_installments: 1 }
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
