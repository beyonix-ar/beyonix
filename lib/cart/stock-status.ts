import {
  getVariantOptionByValue,
} from "../products/product-variants.ts"
import type { SupabaseProducto } from "../supabase/types.ts"

export type StockStatus = "available" | "low" | "out"

export const LOW_STOCK_THRESHOLD = 3
// Genérico: para cambios de disponibilidad que NO son específicamente "pedí
// más cantidad de la que hay" (producto desactivado/eliminado, variante ya
// no existe, error de reserva, etc.). No usar para el caso puntual de stock
// insuficiente — para eso están las constantes de abajo.
export const STOCK_CHANGED_MESSAGE =
  "La disponibilidad del producto cambió desde que comenzaste la compra. Revisá tu carrito antes de continuar."
export const INSUFFICIENT_STOCK_TITLE = "Stock insuficiente"
export const INSUFFICIENT_STOCK_MESSAGE_SINGULAR =
  "La cantidad que seleccionaste supera el stock disponible. Reducí la cantidad para poder continuar con la compra."
export const INSUFFICIENT_STOCK_MESSAGE_PLURAL =
  "Las cantidades que seleccionaste superan el stock disponible de algunos productos. Reducí las cantidades para poder continuar con la compra."
// Límite de compra por producto/variante, también exigido por la RPC de reserva.
export const MAX_CART_ITEM_QUANTITY = 3

export function assertCatalogStock(
  quantity: number,
  product: { stock: number | null; activo?: boolean | null },
  variant?: { stock: number | null; activo?: boolean | null },
) {
  const source = variant ?? product
  if (product.activo === false || source.activo === false) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }
  if (Number(source.stock ?? 0) < quantity) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }
}

export function getProductStock(product: SupabaseProducto, variantValue?: string | null) {
  const variant = getVariantOptionByValue(product, variantValue)

  return Math.max(variant?.stock ?? product.stock ?? 0, 0)
}

/**
 * Tope del selector de cantidad: el menor entre el límite de compra (3) y el
 * stock DISPONIBLE de esa variante (físico - reservas activas, ver
 * lib/inventory/sellable-stock.ts). Sólo UX: reserve_cart_stock es la autoridad.
 */
export function getMaxPurchasableQuantity(product: SupabaseProducto, variantValue?: string | null) {
  return Math.min(MAX_CART_ITEM_QUANTITY, getProductStock(product, variantValue))
}

export interface CartStockIssue {
  productId: number
  color: string
  requested: number
  available: number
}

/**
 * Líneas del carrito cuya cantidad supera el disponible actual. El carrito no
 * reserva ni borra nada: sólo informa y no deja avanzar hasta corregir.
 */
export function getCartStockIssues(
  items: readonly { product: SupabaseProducto; color: string; quantity: number }[],
): CartStockIssue[] {
  return items.flatMap((item) => {
    const available = getProductStock(item.product, item.color)
    return item.quantity > available
      ? [{ productId: item.product.id, color: item.color, requested: item.quantity, available }]
      : []
  })
}

export function getCartStockIssueMessage(issue: Pick<CartStockIssue, "available">) {
  if (issue.available <= 0) {
    return "Sin stock disponible por ahora. Quitalo del carrito para continuar."
  }
  return issue.available === 1
    ? "Sólo queda 1 unidad disponible. Reducí la cantidad para continuar."
    : `Sólo quedan ${issue.available} unidades disponibles. Reducí la cantidad para continuar.`
}

export const CART_STOCK_ISSUES_MESSAGE =
  "Algunos productos ya no tienen la cantidad que elegiste. Corregí las cantidades marcadas para continuar."

export function getStockStatusFromQuantity(stock: number): StockStatus {
  if (stock <= 0) return "out"
  if (stock <= LOW_STOCK_THRESHOLD) return "low"

  return "available"
}

export function getStockStatus(
  product: SupabaseProducto,
  variantValue?: string | null,
) {
  return getStockStatusFromQuantity(getProductStock(product, variantValue))
}

export function getStockStatusLabel(status: StockStatus) {
  if (status === "low") return "Últimas unidades"
  if (status === "out") return "Agotado"

  return "Stock disponible"
}

/**
 * Visibilidad en el catálogo: se evalúa sobre el stock FÍSICO, antes de
 * aplicar reservas (ver prepareStoreProducts).
 */
export function hasPurchasableStock(product: SupabaseProducto) {
  const hasConditionedStock = (product.conditioned_stock ?? []).some(
    (item) => item.active && item.quantity > 0,
  )
  if ((product.stock ?? 0) <= 0 && !hasConditionedStock) return false

  const activeVariants =
    product.producto_variantes?.filter((variant) => variant.activo !== false) ?? []

  if (!activeVariants.length) {
    return (product.stock ?? 0) > 0 || hasConditionedStock
  }

  return (
    activeVariants.some((variant) => (variant.stock ?? 0) > 0) ||
    hasConditionedStock
  )
}
