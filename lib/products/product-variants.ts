import type {
  SupabaseProducto,
  SupabaseProductoVariante,
} from "@/lib/supabase/types"

export const DEFAULT_VARIANT_VALUE = "default"
export const CONDITIONED_VARIANT_PREFIX = "conditioned:"
export const FALLBACK_PRODUCT_IMAGE = "/placeholder.svg"

export interface ProductVariantOption {
  id: number | null
  conditionedStockId: string | null
  name: string
  value: string
  colorHex: string | null
  stock: number
  images: string[]
  sku: string | null
  price: number
  originalPrice: number | null
  discountPercent: number | null
  reason: string | null
  isConditioned: boolean
}

function getBaseProductImages(product: SupabaseProducto) {
  const gallery =
    product.imagenes_producto
      ?.map((image) => image.url)
      .filter(Boolean) ?? []

  const images = product.imagen_principal
    ? [product.imagen_principal, ...gallery]
    : gallery

  return images.length ? images : [FALLBACK_PRODUCT_IMAGE]
}

function getSortedActiveVariants(product: SupabaseProducto) {
  return (product.producto_variantes ?? [])
    .filter((variant) => variant.activo !== false)
    .sort((a, b) => {
      if (a.orden !== b.orden) return a.orden - b.orden
      return a.id - b.id
    })
}

export function getVariantValue(variant: SupabaseProductoVariante) {
  return `variant:${variant.id}`
}

export function getVariantIdFromValue(value?: string | null) {
  if (!value) return null

  const match = value.match(/^variant:(\d+)$/)
  if (!match) return null

  const id = Number(match[1])
  return Number.isFinite(id) ? id : null
}

export function getConditionedStockIdFromValue(value?: string | null) {
  if (!value?.startsWith(CONDITIONED_VARIANT_PREFIX)) return null

  const id = value.slice(CONDITIONED_VARIANT_PREFIX.length)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  )
    ? id
    : null
}

export function getProductVariantOptions(
  product: SupabaseProducto,
): ProductVariantOption[] {
  const baseImages = getBaseProductImages(product)
  const variants = getSortedActiveVariants(product)
  const conditionedVariants = (product.conditioned_stock ?? [])
    .filter(
      (item) =>
        item.active &&
        item.quantity > 0 &&
        item.discount_percent > 0 &&
        item.discount_percent < 100 &&
        Boolean(item.conditioned_name?.trim()) &&
        Boolean(item.conditioned_sku?.trim()) &&
        Boolean(item.conditioned_color_hex),
    )
    .map<ProductVariantOption>((item) => ({
      id: null,
      conditionedStockId: item.id,
      name: item.conditioned_name!.trim(),
      value: `${CONDITIONED_VARIANT_PREFIX}${item.id}`,
      colorHex: item.conditioned_color_hex,
      stock: item.quantity,
      images: item.conditioned_images.length
        ? item.conditioned_images
        : baseImages,
      sku: item.conditioned_sku?.trim() || null,
      price: Math.max(
        Math.round(product.precio * (1 - item.discount_percent / 100)),
        0,
      ),
      originalPrice: product.precio,
      discountPercent: item.discount_percent,
      reason: item.reason,
      isConditioned: true,
    }))

  if (!variants.length) {
    return [
      {
        id: null,
        conditionedStockId: null,
        name: "Default",
        value: DEFAULT_VARIANT_VALUE,
        colorHex: null,
        stock: product.stock,
        images: baseImages,
        sku: product.sku?.trim() || null,
        price: product.precio,
        originalPrice: product.precio_anterior,
        discountPercent: product.descuento,
        reason: null,
        isConditioned: false,
      },
      ...conditionedVariants,
    ]
  }

  return [
    ...variants.map((variant) => {
      const images =
        Array.isArray(variant.imagenes) && variant.imagenes.length
          ? variant.imagenes
          : baseImages

      return {
        id: variant.id,
        conditionedStockId: null,
        name: variant.nombre,
        value: getVariantValue(variant),
        colorHex: variant.color_hex,
        stock: variant.stock ?? 0,
        images,
        sku: variant.sku?.trim() || null,
        price: product.precio,
        originalPrice: product.precio_anterior,
        discountPercent: product.descuento,
        reason: null,
        isConditioned: false,
      }
    }),
    ...conditionedVariants,
  ]
}

export function getDefaultVariantOption(product: SupabaseProducto) {
  const options = getProductVariantOptions(product)

  return options.find((option) => option.stock > 0) ?? options[0]
}

export function getDefaultVariantValue(product: SupabaseProducto) {
  return getDefaultVariantOption(product)?.value ?? DEFAULT_VARIANT_VALUE
}

export function getVariantOptionByValue(
  product: SupabaseProducto,
  value?: string | null,
) {
  const options = getProductVariantOptions(product)

  return (
    options.find((option) => option.value === value) ??
    options.find((option) => option.name === value) ??
    options[0]
  )
}

export function getProductImagesByVariant(
  product: SupabaseProducto,
  value?: string | null,
) {
  return getVariantOptionByValue(product, value)?.images ?? getBaseProductImages(product)
}
