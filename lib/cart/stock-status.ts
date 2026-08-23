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
// Techo puramente técnico del selector de cantidad del cliente: no está
// atado al stock real (que nunca se expone en el frontend) y solo evita un
// abuso extremo accidental del control +. La validación que sí importa —
// contra el stock vendible real — ocurre server-side antes de pagar.
export const MAX_CART_ITEM_QUANTITY = 999

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
