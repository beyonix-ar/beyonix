/**
 * Línea del carrito y su normalización desde storage (sessionStorage del
 * invitado / localStorage de la cuenta). Funciones puras, sin React ni
 * Supabase: las usa `context/cart-context.tsx` y se testean en `node --test`.
 */

import type { SupabaseProducto } from "../supabase/types.ts"
import {
  DEFAULT_VARIANT_VALUE,
  FALLBACK_PRODUCT_IMAGE,
  getDefaultVariantValue,
  getProductImagesByVariant,
  getVariantOptionByValue,
} from "../products/product-variants.ts"

export interface CartItem {
  product: SupabaseProducto
  color: string
  image: string
  quantity: number
  variantId: number | null
  conditionedStockId: string | null
  variantName: string | null
  colorHex: string | null
  secondaryColorHex?: string | null
  unitPrice: number
  originalUnitPrice: number | null
  discountReason: string | null
}

export function toFiniteNumber(value: unknown, fallback = 0) {
  const numberValue = typeof value === "number" ? value : Number(value)

  return Number.isFinite(numberValue) ? numberValue : fallback
}

export function getProductImage(product: SupabaseProducto, image?: string) {
  return image || getProductImagesByVariant(product)[0] || FALLBACK_PRODUCT_IMAGE
}

export function resolveCartVariant(product: SupabaseProducto, color?: string) {
  const value =
    color && color !== DEFAULT_VARIANT_VALUE
      ? color
      : getDefaultVariantValue(product)

  return getVariantOptionByValue(product, value)
}

function normalizeCartItem(item: unknown): CartItem | null {
  if (!item || typeof item !== "object") return null

  const rawItem = item as Record<string, unknown>
  const rawProduct = rawItem.product

  if (!rawProduct || typeof rawProduct !== "object") return null

  const productRecord = rawProduct as Record<string, unknown>
  const id = toFiniteNumber(productRecord.id, NaN)
  const precio = toFiniteNumber(productRecord.precio, NaN)
  const quantity = Math.trunc(toFiniteNumber(rawItem.quantity, 1))
  const nombre = productRecord.nombre

  if (
    !Number.isFinite(id) ||
    !Number.isFinite(precio) ||
    typeof nombre !== "string" ||
    quantity < 1
  ) {
    return null
  }

  const product = {
    ...productRecord,
    id,
    nombre,
    precio,
  } as SupabaseProducto

  const rawColor =
    typeof rawItem.color === "string"
      ? rawItem.color
      : DEFAULT_VARIANT_VALUE
  const variant = resolveCartVariant(product, rawColor)
  // `null` (producto sin variantes) no es la variante 0: `Number(null) === 0`
  // hacía que el refresco comercial quitara la línea al restaurar el carrito.
  const variantId =
    rawItem.variantId == null
      ? variant?.id ?? NaN
      : toFiniteNumber(rawItem.variantId, variant?.id ?? NaN)
  const storedUnitPrice = toFiniteNumber(rawItem.unitPrice, NaN)

  return {
    product,
    color: variant?.value ?? rawColor,
    image:
      typeof rawItem.image === "string" && rawItem.image.trim()
        ? rawItem.image
        : variant?.images[0] ?? getProductImage(product),
    quantity,
    variantId: Number.isFinite(variantId) ? variantId : null,
    conditionedStockId:
      typeof rawItem.conditionedStockId === "string"
        ? rawItem.conditionedStockId
        : variant?.conditionedStockId ?? null,
    variantName:
      typeof rawItem.variantName === "string"
        ? rawItem.variantName
        : variant?.name ?? null,
    colorHex:
      typeof rawItem.colorHex === "string"
        ? rawItem.colorHex
        : variant?.colorHex ?? null,
    secondaryColorHex:
      typeof rawItem.secondaryColorHex === "string"
        ? rawItem.secondaryColorHex
        : variant?.secondaryColorHex ?? null,
    unitPrice: Number.isFinite(storedUnitPrice)
      ? Math.max(storedUnitPrice, 0)
      : variant?.price ?? product.precio,
    originalUnitPrice:
      typeof rawItem.originalUnitPrice === "number"
        ? rawItem.originalUnitPrice
        : variant?.originalPrice ?? null,
    discountReason:
      typeof rawItem.discountReason === "string"
        ? rawItem.discountReason
        : variant?.reason ?? null,
  }
}

export function normalizeCart(items: unknown) {
  if (!Array.isArray(items)) return []

  return items.reduce<CartItem[]>((acc, item) => {
    const normalized = normalizeCartItem(item)

    if (!normalized) return acc

    const existing = acc.find(
      (cartItem) =>
        cartItem.product.id === normalized.product.id &&
        cartItem.color === normalized.color,
    )
    // Una línea sin stock disponible NO se descarta en silencio: el snapshot
    // guardado puede estar desactualizado (p. ej. una reserva ajena que ya
    // venció). El refresco de catálogo trae el disponible vigente y el
    // carrito marca la línea hasta que el cliente la corrija.

    if (existing) {
      existing.quantity += normalized.quantity
      return acc
    }

    acc.push(normalized)
    return acc
  }, [])
}
