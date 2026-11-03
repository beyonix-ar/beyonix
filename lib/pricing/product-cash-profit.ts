import { calculateCartTotals } from "../cart/cart-totals.ts"
import {
  getSinglePaymentEffectivePercent,
  type InstallmentsFinancingConfig,
} from "../products/installments.ts"
import {
  getSinglePaymentProfitAmount,
  simulateProductProfitability,
} from "./product-pricing.ts"

/**
 * "Ganancia estimada al contado" de Admin → Productos: una unidad cobrada por
 * Mercado Pago en 1 pago (débito o crédito en 1 pago) al precio de contado
 * que hoy paga el cliente. Es una PROYECCIÓN, no una ganancia realizada:
 *
 *   ganancia = precio efectivo × (1 − % efectivo MP 1 pago / 100) − costo unitario vigente
 *
 * No entra nada que dependa del pedido o del medio elegido: ni envío ni su
 * bonificación, ni el descuento por transferencia, ni cuotas/financiación,
 * ni costos generales del negocio. La fórmula no se repite acá: es el
 * escenario "Mercado Pago — 1 pago" de `simulateProductProfitability`, el
 * mismo que muestra "Rentabilidad estimada" en el editor.
 */

export interface CashProfitVariantInput {
  /** `null` sólo para un producto sin variantes (costo a nivel producto). */
  variantId: number | null
  variantName: string | null
  /** Costo vigente de compras recibidas; `null` = desconocido (nunca se inventa). */
  unitCost: number | null
  /** Variante (o producto simple) activa comercialmente. */
  active: boolean
  /**
   * Stock DISPONIBLE hoy (físico − reservas activas), calculado con
   * lib/inventory/sellable-stock.ts — la misma fuente que catálogo y checkout.
   */
  availableStock: number
}

export interface SinglePaymentFeeInput {
  installmentsFinancing: InstallmentsFinancingConfig
  /** "observed" = comisión aprendida de un pago real; "manual" = cargada en Admin → Financiación. */
  baseSource: "observed" | "manual"
  manualBaseConfirmed: boolean
  transferDiscountPercent: number
}

export interface CashProfitInput {
  productId: number
  /** `productos.activo`: un producto inactivo no se vende (catálogo y carrito lo excluyen). */
  productActive: boolean
  /** `productos.precio` (precio público de contado, antes de eventos). */
  price: number | null
  variants: CashProfitVariantInput[]
  fee: SinglePaymentFeeInput
}

export interface CashProfitVariantResult {
  variantId: number | null
  variantName: string | null
  unitCost: number
  profitAmount: number
}

export type CashProfitUnavailableReason =
  | "product_inactive"
  | "fee_unconfigured"
  | "no_price"
  | "no_sellable_stock"
  | "no_cost"

export type ProductCashProfitEstimate =
  | {
      status: "available"
      /** Precio que hoy paga el cliente al contado (con el descuento de evento vigente, si hay). */
      cashPrice: number
      feePercent: number
      feeSource: "observed" | "manual"
      minProfit: number
      maxProfit: number
      variants: CashProfitVariantResult[]
      /** Variantes vendibles sin costo conocido: quedan fuera del rango y se avisan. */
      missingCostVariants: Array<{ variantId: number | null; variantName: string | null }>
    }
  | {
      status: "unavailable"
      reason: CashProfitUnavailableReason
      message: string
    }

const UNAVAILABLE_MESSAGES: Record<CashProfitUnavailableReason, string> = {
  product_inactive: "Producto inactivo.",
  fee_unconfigured: "Falta configurar el costo de Mercado Pago en 1 pago (Admin → Financiación).",
  no_price: "El producto no tiene precio de venta.",
  no_sellable_stock: "Sin stock vendible.",
  no_cost: "Falta el costo de compra recibida.",
}

/** Respuesta "No disponible" con el mensaje estándar del motivo (la ruta la usa para cortar antes de leer costos). */
export function unavailable(reason: CashProfitUnavailableReason, message = UNAVAILABLE_MESSAGES[reason]): ProductCashProfitEstimate {
  return { status: "unavailable", reason, message }
}

/** Entra en la proyección sólo lo que hoy se puede vender: activo y con disponible > 0. */
export function isSellableNow(variant: Pick<CashProfitVariantInput, "active" | "availableStock">) {
  return variant.active && Number.isFinite(variant.availableStock) && variant.availableStock > 0
}

const roundMoney = (value: number) => Math.round(value * 100) / 100

/**
 * La comisión de 1 pago sólo es confiable si salió de un pago real o si el
 * Admin la confirmó (comisión base + IVA). Un default nunca confirmado no
 * puede presentarse como ganancia.
 */
export function isSinglePaymentFeeReliable(fee: SinglePaymentFeeInput) {
  const percent = getSinglePaymentEffectivePercent(fee.installmentsFinancing)
  return (
    Number.isFinite(percent) &&
    percent > 0 &&
    percent < 100 &&
    (fee.baseSource === "observed" || fee.manualBaseConfirmed)
  )
}

/**
 * Precio de contado que hoy paga el cliente: el mismo cálculo del carrito
 * (`calculateCartTotals`, que aplica el descuento del evento vigente), nunca
 * `precio_anterior` ni el precio con transferencia.
 */
export function getCurrentCashUnitPrice(productId: number, price: number) {
  return roundMoney(
    calculateCartTotals([{ product: { id: productId, precio: price }, quantity: 1 }], {
      shippingCost: 0,
    }).productsTotal,
  )
}

export function estimateProductCashProfit({
  productId,
  productActive,
  price,
  variants,
  fee,
}: CashProfitInput): ProductCashProfitEstimate {
  // El padre inactivo no se vende, tenga o no variantes activas con stock.
  if (!productActive) return unavailable("product_inactive")
  if (!isSinglePaymentFeeReliable(fee)) return unavailable("fee_unconfigured")
  if (price == null || !Number.isFinite(price) || price <= 0) return unavailable("no_price")

  // Variantes sin stock vendible quedan fuera del rango, del detalle y de la
  // advertencia de costo: su ganancia no es relevante hoy.
  const sellable = variants.filter(isSellableNow)
  if (sellable.length === 0) {
    const hasVariants = variants.some((variant) => variant.variantId != null)
    return unavailable(
      "no_sellable_stock",
      hasVariants ? "Sin variantes con stock vendible." : UNAVAILABLE_MESSAGES.no_sellable_stock,
    )
  }

  const cashPrice = getCurrentCashUnitPrice(productId, price)
  const results: CashProfitVariantResult[] = []
  const missingCostVariants: Array<{ variantId: number | null; variantName: string | null }> = []

  for (const variant of sellable) {
    const simulation =
      variant.unitCost == null
        ? null
        : simulateProductProfitability({
            price: cashPrice,
            cost: variant.unitCost,
            config: fee.installmentsFinancing,
            transferDiscountPercent: fee.transferDiscountPercent,
          })
    const profit = simulation ? getSinglePaymentProfitAmount(simulation) : null
    if (variant.unitCost == null || profit == null) {
      missingCostVariants.push({ variantId: variant.variantId, variantName: variant.variantName })
      continue
    }
    results.push({
      variantId: variant.variantId,
      variantName: variant.variantName,
      unitCost: variant.unitCost,
      profitAmount: roundMoney(profit),
    })
  }

  if (results.length === 0) return unavailable("no_cost")

  const profits = results.map((result) => result.profitAmount)
  return {
    status: "available",
    cashPrice,
    feePercent: getSinglePaymentEffectivePercent(fee.installmentsFinancing),
    feeSource: fee.baseSource,
    minProfit: Math.min(...profits),
    maxProfit: Math.max(...profits),
    variants: results,
    missingCostVariants,
  }
}
