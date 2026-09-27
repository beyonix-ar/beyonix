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

export const STOCK_LIMIT_RESERVED_MESSAGE =
  "No hay más unidades disponibles ahora. Otro cliente tiene reservadas las unidades restantes. Si su compra vence o se cancela, volverán a estar disponibles."
/** Reservas cuya pertenencia no se puede afirmar (propias u origen incierto). */
export const STOCK_LIMIT_RESERVED_NEUTRAL_MESSAGE =
  "Hay unidades temporalmente reservadas. Si la reserva vence o se cancela, volverán a estar disponibles."
export const STOCK_LIMIT_EXHAUSTED_MESSAGE = "No hay más unidades disponibles."
export const PURCHASE_LIMIT_MESSAGE = "Podés comprar hasta 3 unidades por producto o variante."

/**
 * Físico y disponible de la variante elegida. `physical_*` sólo existe si el
 * producto se leyó con reservas (lib/inventory/sellable-stock.ts); si no, el
 * físico es el mismo stock mostrado.
 */
export function getVariantStockBreakdown(product: SupabaseProducto, variantValue?: string | null) {
  const option = getVariantOptionByValue(product, variantValue)
  const available = getProductStock(product, variantValue)
  let physical: number | null | undefined
  let foreignReserved: number | null | undefined
  if (option?.conditionedStockId) {
    const item = product.conditioned_stock?.find((entry) => entry.id === option.conditionedStockId)
    physical = item?.physical_quantity
    foreignReserved = item?.foreign_reserved_quantity
  } else if (option?.id != null) {
    const variant = product.producto_variantes?.find((entry) => entry.id === option.id)
    physical = variant?.physical_stock
    foreignReserved = variant?.foreign_reserved_stock
  } else {
    physical = product.physical_stock
    foreignReserved = product.foreign_reserved_stock
  }
  return {
    available,
    physical: Math.max(physical ?? available, available),
    /** Reservado con certeza por OTRA cuenta (0 si no se puede saber). */
    foreignReserved: Math.max(0, foreignReserved ?? 0),
  }
}

/**
 * Por qué no se puede sumar otra unidad (null si se puede). Distingue el
 * límite de compra (3), unidades retenidas por reservas activas y stock
 * físico agotado. Sólo UI: no cambia ninguna regla.
 *
 * "Otro cliente…" sólo cuando las reservas de OTRA cuenta (certeza de la
 * base: usuario autenticado distinto) alcanzan por sí solas para bloquear.
 * Si el bloqueo depende de reservas propias (otra pestaña/dispositivo) o de
 * origen incierto (invitados, sin sesión), el texto es neutro.
 */
export function getQuantityLimitMessage(
  product: SupabaseProducto,
  variantValue: string | null | undefined,
  quantity: number,
) {
  const { available, physical, foreignReserved } = getVariantStockBreakdown(product, variantValue)
  if (quantity < Math.min(MAX_CART_ITEM_QUANTITY, available)) return null
  if (available >= MAX_CART_ITEM_QUANTITY) return PURCHASE_LIMIT_MESSAGE
  if (physical <= quantity) return STOCK_LIMIT_EXHAUSTED_MESSAGE
  return physical - foreignReserved <= quantity
    ? STOCK_LIMIT_RESERVED_MESSAGE
    : STOCK_LIMIT_RESERVED_NEUTRAL_MESSAGE
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
