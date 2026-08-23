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

function normalizeImageUrls(images: readonly string[]) {
  const seen = new Set<string>()

  return images.reduce<string[]>((normalized, image) => {
    const url = image.trim()
    if (!url || seen.has(url)) return normalized

    seen.add(url)
    normalized.push(url)
    return normalized
  }, [])
}

function getBaseProductImages(product: SupabaseProducto) {
  const variants = [...(product.producto_variantes ?? [])].sort(
    (left, right) => left.orden - right.orden || left.id - right.id,
  )
  const variantGallery = normalizeImageUrls(
    variants.flatMap((variant) =>
      Array.isArray(variant.imagenes) ? variant.imagenes : [],
    ),
  )

  // Mientras un producto con variantes todavía no tiene ninguna activa
  // (caso normal durante la edición), la vista previa necesita una galería
  // agregada. Se deriva de producto_variantes.imagenes, no de la tabla
  // paralela de productos simples.
  if (variantGallery.length) return variantGallery

  // Para un producto sin variantes, imagenes_producto es la galería
  // canónica y su orden define también la imagen inicial. También conserva
  // compatibilidad con variantes históricas que aún no tengan URLs propias.
  // imagen_principal sólo funciona como fallback cuando no existe galería;
  // anteponerlo siempre duplicaba la primera imagen cuando ambas fuentes
  // apuntaban a la misma URL.
  const gallery = normalizeImageUrls(
    [...(product.imagenes_producto ?? [])]
      .sort((left, right) => left.orden - right.orden || left.id - right.id)
      .map((image) => image.url),
  )

  if (gallery.length) return gallery

  const primaryImage = product.imagen_principal?.trim()
  return primaryImage ? [primaryImage] : [FALLBACK_PRODUCT_IMAGE]
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
    .map<ProductVariantOption>((item) => {
      const conditionedImages = normalizeImageUrls(item.conditioned_images)

      return {
        id: null,
        conditionedStockId: item.id,
        name: item.conditioned_name!.trim(),
        value: `${CONDITIONED_VARIANT_PREFIX}${item.id}`,
        colorHex: item.conditioned_color_hex,
        stock: item.quantity,
        images: conditionedImages.length ? conditionedImages : baseImages,
        sku: item.conditioned_sku?.trim() || null,
        price: Math.max(
          Math.round(product.precio * (1 - item.discount_percent / 100)),
          0,
        ),
        originalPrice: product.precio,
        discountPercent: item.discount_percent,
        reason: item.reason,
        isConditioned: true,
      }
    })

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
      const variantImages = Array.isArray(variant.imagenes)
        ? normalizeImageUrls(variant.imagenes)
        : []
      const images =
        variantImages.length
          ? variantImages
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
