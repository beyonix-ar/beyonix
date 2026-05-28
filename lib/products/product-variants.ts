import type {
  SupabaseProducto,
  SupabaseProductoVariante,
} from "@/lib/supabase/types"

export const DEFAULT_VARIANT_VALUE = "default"
export const FALLBACK_PRODUCT_IMAGE = "/placeholder.svg"

export interface ProductVariantOption {
  id: number | null
  name: string
  value: string
  colorHex: string | null
  stock: number
  images: string[]
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

export function getProductVariantOptions(
  product: SupabaseProducto,
): ProductVariantOption[] {
  const baseImages = getBaseProductImages(product)
  const variants = getSortedActiveVariants(product)

  if (!variants.length) {
    return [
      {
        id: null,
        name: "Default",
        value: DEFAULT_VARIANT_VALUE,
        colorHex: null,
        stock: product.stock,
        images: baseImages,
      },
    ]
  }

  return variants.map((variant) => {
    const images =
      Array.isArray(variant.imagenes) && variant.imagenes.length
        ? variant.imagenes
        : baseImages

    return {
      id: variant.id,
      name: variant.nombre,
      value: getVariantValue(variant),
      colorHex: variant.color_hex,
      stock: variant.stock ?? 0,
      images,
    }
  })
}

export function getDefaultVariantOption(product: SupabaseProducto) {
  return getProductVariantOptions(product)[0]
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
