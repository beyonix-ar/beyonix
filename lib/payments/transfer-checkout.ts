/**
 * Cálculo canónico del checkout por transferencia, extraído LITERALMENTE de
 * `/api/transferencia/create-order` (mismas fórmulas, mismo orden) para que
 * sea testeable y para armar la huella económica del intento. Las fórmulas
 * no cambian: la única diferencia es que el saldo a favor se calcula contra
 * el saldo PEDIDO y la disponibilidad real se valida aparte en la ruta
 * (necesario para poder evaluar un intento viejo que todavía retiene saldo).
 *
 * Unidad: todos los montos en PESOS (2 decimales).
 */

import {
  calculateCustomerCreditApplication,
  roundMoney,
} from "../customer-credit.ts"
import { calculateStoreBenefitDiscount } from "../customer-store-benefits.ts"
import { getPriceWithoutNationalTaxes } from "../pricing/financed-pricing.ts"
import { calculateTransferPaymentTotalAfterCustomerCredit } from "./transfer.ts"

export interface TransferCheckoutPricingInput {
  /** Productos a precio de contado (`calculateCartTotals(...).productsTotal`). */
  productsTotal: number
  /** Envío efectivamente cobrado al cliente. */
  shippingCharged: number
  storeBenefitPercent: number | null
  /** Saldo a favor pedido; la disponibilidad real se valida en la ruta. */
  requestedCustomerCredit: number
  transferDiscountPercent: number
  nationalTaxesIncidencePercent: number
}

export function calculateTransferCheckoutPricing({
  productsTotal,
  shippingCharged,
  storeBenefitPercent,
  requestedCustomerCredit,
  transferDiscountPercent,
  nationalTaxesIncidencePercent,
}: TransferCheckoutPricingInput) {
  const storeBenefitDiscountAmount = calculateStoreBenefitDiscount(
    productsTotal,
    storeBenefitPercent,
  )
  const productsTotalAfterStoreBenefit = Math.max(
    productsTotal - storeBenefitDiscountAmount,
    0,
  )
  const creditBeforeTransferDiscount =
    requestedCustomerCredit > 0
      ? calculateCustomerCreditApplication({
          availableBalance: requestedCustomerCredit,
          eligibleTotal: productsTotalAfterStoreBenefit + shippingCharged,
          requestedAmount: requestedCustomerCredit,
        })
      : { appliedAmount: 0 }
  const transferPaymentTotals = calculateTransferPaymentTotalAfterCustomerCredit({
    productsTotal: productsTotalAfterStoreBenefit,
    shipping: shippingCharged,
    customerCreditAmount: creditBeforeTransferDiscount.appliedAmount,
    transferDiscountPercent,
  })
  const transferDiscountAmount = transferPaymentTotals.discount
  const transferTotal = roundMoney(
    productsTotalAfterStoreBenefit + shippingCharged - transferDiscountAmount,
  )
  const customerCreditApplication =
    requestedCustomerCredit > 0
      ? calculateCustomerCreditApplication({
          availableBalance: requestedCustomerCredit,
          eligibleTotal: transferTotal,
          requestedAmount: requestedCustomerCredit,
        })
      : { appliedAmount: 0, externalAmountDue: transferTotal }
  const cashTotalBeforeTransferDiscount = roundMoney(
    productsTotalAfterStoreBenefit + shippingCharged,
  )

  return {
    storeBenefitDiscountAmount,
    transferDiscountPercent,
    transferDiscountAmount,
    transferTotal,
    cashTotalBeforeTransferDiscount,
    customerCreditApplied: customerCreditApplication.appliedAmount,
    externalAmountDue: customerCreditApplication.externalAmountDue,
    requestedCreditExceedsTotal:
      requestedCustomerCredit > 0 &&
      Math.abs(customerCreditApplication.appliedAmount - requestedCustomerCredit) > 0.009,
    pricingSnapshot: {
      cashPriceTotal: cashTotalBeforeTransferDiscount,
      transferPriceTotal: transferTotal,
      financedPriceTotal: null,
      maxInstallmentCount: null,
      transferDiscountPercent,
      nationalTaxesIncidencePercent,
      cftea: null,
      installmentsRoundingAdjustment: 0,
      priceWithoutNationalTaxes: {
        cash: getPriceWithoutNationalTaxes(
          cashTotalBeforeTransferDiscount,
          nationalTaxesIncidencePercent,
        ),
        financed: null,
      },
    },
  }
}

export type TransferCheckoutPricing = ReturnType<typeof calculateTransferCheckoutPricing>

/**
 * Filas del "Resumen del pedido" para transferencia (sólo presentación). El
 * descuento por transferencia se calcula únicamente sobre productos
 * (`calculateTransferPaymentTotalAfterCustomerCredit`; el envío nunca se
 * descuenta), así que se muestra ya aplicado en "Productos":
 * Productos (con descuento) − Beneficio + Envío = Total, exacto.
 */
export function getTransferSummaryBreakdown({
  productsTotal,
  storeBenefitDiscountAmount,
  shipping,
  transferDiscountAmount,
}: {
  productsTotal: number
  storeBenefitDiscountAmount: number
  shipping: number
  transferDiscountAmount: number
}) {
  const productsSubtotal = roundMoney(Math.max(productsTotal - transferDiscountAmount, 0))
  return {
    productsSubtotal,
    storeBenefitDiscount: storeBenefitDiscountAmount,
    shipping,
    total: roundMoney(productsSubtotal - storeBenefitDiscountAmount + shipping),
  }
}

export interface TransferEconomicLine {
  productId: number
  variantId: number | null
  conditionedStockId: string | null
  quantity: number
  unitPrice: number
}

function toCents(amount: number | null | undefined) {
  return Number.isFinite(amount) ? Math.round(Number(amount) * 100) : null
}

/**
 * Estado económico canónico de un pedido por transferencia: si cualquiera
 * de estos valores cambia (precio, cantidad, variante, envío, beneficio,
 * saldo, % de transferencia, datos de entrega), un pedido pendiente previo
 * deja de ser "el mismo" y no puede devolverse como si lo fuera. Montos en
 * centavos enteros y porcentajes en puntos básicos: determinístico.
 */
export function buildTransferEconomicState({
  lines,
  shipping,
  customer,
  storeBenefit,
  requestedCustomerCredit,
  pricing,
  nationalTaxesIncidencePercent,
}: {
  lines: TransferEconomicLine[]
  shipping: {
    provider: string
    type: string
    sucursalId: string | number | null
    costReal: number
    costCharged: number
    freeShippingApplied: boolean
  }
  customer: Record<string, string | null>
  storeBenefit: { id: string; percent: number } | null
  requestedCustomerCredit: number
  pricing: TransferCheckoutPricing
  nationalTaxesIncidencePercent: number
}) {
  return {
    version: 1,
    method: "transferencia",
    lines: [...lines]
      .map((line) => ({
        productId: line.productId,
        variantId: line.variantId,
        conditionedStockId: line.conditionedStockId,
        quantity: line.quantity,
        unitPriceCents: toCents(line.unitPrice),
      }))
      .sort(
        (left, right) =>
          left.productId - right.productId ||
          (left.variantId ?? 0) - (right.variantId ?? 0) ||
          (left.conditionedStockId ?? "").localeCompare(right.conditionedStockId ?? ""),
      ),
    shipping: {
      provider: shipping.provider,
      type: shipping.type,
      sucursalId: shipping.sucursalId != null ? String(shipping.sucursalId) : null,
      costRealCents: toCents(shipping.costReal),
      costChargedCents: toCents(shipping.costCharged),
      freeShippingApplied: shipping.freeShippingApplied,
    },
    customer,
    storeBenefit: storeBenefit ? { id: storeBenefit.id, percent: storeBenefit.percent } : null,
    requestedCustomerCreditCents: toCents(requestedCustomerCredit),
    transferDiscountBp: Math.round(pricing.transferDiscountPercent * 100),
    nationalTaxesIncidenceBp: Math.round(nationalTaxesIncidencePercent * 100),
    totals: {
      transferTotalCents: toCents(pricing.transferTotal),
      transferDiscountCents: toCents(pricing.transferDiscountAmount),
      externalAmountDueCents: toCents(pricing.externalAmountDue),
      customerCreditAppliedCents: toCents(pricing.customerCreditApplied),
    },
  }
}

export type TransferEconomicState = ReturnType<typeof buildTransferEconomicState>
