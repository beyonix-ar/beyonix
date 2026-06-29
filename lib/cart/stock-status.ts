import {
  getVariantOptionByValue,
} from "@/lib/products/product-variants"
import type { SupabaseProducto } from "@/lib/supabase/types"

export type StockStatus = "available" | "low" | "out"

export const LOW_STOCK_THRESHOLD = 5
export const STOCK_LIMIT_MESSAGE =
  "No es posible agregar más unidades de este producto."
export const STOCK_CHANGED_MESSAGE =
  "La disponibilidad del producto cambió desde que comenzaste la compra. Revisá tu carrito antes de continuar."

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
  if ((product.stock ?? 0) <= 0) return false

  const activeVariants =
    product.producto_variantes?.filter((variant) => variant.activo !== false) ?? []

  if (!activeVariants.length) return true

  return activeVariants.some((variant) => (variant.stock ?? 0) > 0)
}
