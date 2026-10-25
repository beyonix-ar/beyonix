import { richDescriptionToPlainText } from "./rich-description.ts"

export interface ProductActivationSpecification {
  activo: boolean
  icono: string
  texto: string
}

export interface ProductActivationVariant {
  id: number | string
  orden: number
  active?: boolean
  nombre: string
  sku: string | null
  colorHex: string
  images: readonly string[] | readonly File[]
  barcode: string | null
  assignedStock: number
  /** Estado guardado; `false` = la variante pasa a activa en este guardado. */
  persistedActive?: boolean
}

export interface ProductActivationInput {
  /**
   * `true` (default): requisitos para PUBLICAR (transición inactivo -> activo),
   * como product_activation_error: además exige stock y código de barra, y al
   * menos una variante activa vendible. `false`: producto ya publicado; sólo
   * las invariantes (un publicado que se quedó sin stock se sigue editando).
   */
  publishing?: boolean
  title: string
  sku: string
  price: number
  categoryId: number | null
  categoryExists: boolean
  description: string
  specifications: readonly ProductActivationSpecification[]
  logistics: {
    weight: number | null
    depth: number | null
    width: number | null
    length: number | null
  }
  variants: readonly ProductActivationVariant[]
}

export interface ProductActivationRequirement {
  key:
    | "title"
    | "sku"
    | "price"
    | "category"
    | "description"
    | "specifications"
    | "logistics"
    | "images"
    | "primaryVariant"
    | "activeVariants"
  label: string
  complete: boolean
}

export interface ProductActivationStatus {
  ready: boolean
  firstError: string | null
  requirements: ProductActivationRequirement[]
  primaryVariant: ProductActivationVariant | null
}

const VALID_COLOR_PATTERN = /^#[0-9A-F]{6}$/i

function positiveFinite(value: number | null) {
  return value != null && Number.isFinite(value) && value > 0
}

export function sortProductActivationVariants(
  variants: readonly ProductActivationVariant[],
) {
  return variants
    .map((variant, sourceIndex) => ({ variant, sourceIndex }))
    .sort((left, right) => {
      if (left.variant.orden !== right.variant.orden) {
        return left.variant.orden - right.variant.orden
      }

      if (
        typeof left.variant.id === "number" &&
        typeof right.variant.id === "number"
      ) {
        return left.variant.id - right.variant.id
      }

      return left.sourceIndex - right.sourceIndex
    })
    .map(({ variant }) => variant)
}

/**
 * Mismo orden y criterio que product_variant_listing_error: `requireStock`
 * (código de barra + stock) sólo cuando la variante o el producto se activan.
 */
export function getVariantActivationError(
  variant: ProductActivationVariant,
  principal = false,
  requireStock = true,
) {
  const subject = principal ? "La variante principal" : "La variante"

  if (!variant.nombre.trim()) return `${subject} necesita un nombre.`
  if (!variant.sku?.trim()) return `${subject} necesita un SKU.`
  if (!VALID_COLOR_PATTERN.test(variant.colorHex.trim())) {
    return `${subject} necesita un color.`
  }
  if (variant.images.length === 0) {
    return `${subject} necesita al menos una imagen.`
  }
  if (!requireStock) return null
  // Mismo orden que product_variant_listing_error (20261007100000).
  if (!variant.barcode?.trim()) {
    return `${subject} necesita un código de barra (de fabricante o BEYONIX).`
  }
  if (!positiveFinite(variant.assignedStock)) {
    return `${subject} necesita stock asignado.`
  }

  return null
}

export function getProductActivationStatus(
  input: ProductActivationInput,
): ProductActivationStatus {
  const primaryVariant = sortProductActivationVariants(input.variants)[0] ?? null
  const activeSpecification = input.specifications.some(
    (specification) =>
      specification.activo &&
      Boolean(specification.icono.trim()) &&
      Boolean(specification.texto.trim()),
  )
  const publishing = input.publishing ?? true
  const logisticsComplete = Object.values(input.logistics).every(positiveFinite)
  const primaryVariantError = primaryVariant
    ? getVariantActivationError(primaryVariant, true, publishing)
    : "Creá al menos una variante."
  const activeVariants = input.variants.filter((variant) => variant.active === true)
  // Como validate_variant_commercial_state: stock y código sólo se exigen a la
  // variante que pasa a activa (o a todas si se publica el producto).
  const activeVariantError = activeVariants
    .map((variant) =>
      getVariantActivationError(
        variant,
        false,
        publishing || variant.persistedActive !== true,
      ),
    )
    .find((error): error is string => error != null) ?? null
  // Publicar exige al menos una variante activa y vendible (20261025100000).
  const sellableActiveVariant = activeVariants.some(
    (variant) => getVariantActivationError(variant, false, true) == null,
  )
  const activeVariantsError = publishing && !sellableActiveVariant
    ? "Activá al menos una variante vendible antes de publicar el producto."
    : null

  // Una descripción enriquecida sin texto visible ("<p><br></p>") no cuenta,
  // igual que rich_description_has_visible_text en la base.
  const hasDescription = richDescriptionToPlainText(input.description) !== ""

  const requirements: ProductActivationRequirement[] = [
    { key: "title", label: "Nombre", complete: Boolean(input.title.trim()) },
    { key: "sku", label: "SKU", complete: Boolean(input.sku.trim()) },
    { key: "price", label: "Precio", complete: positiveFinite(input.price) },
    {
      key: "category",
      label: "Categoría",
      complete: input.categoryId != null && input.categoryExists,
    },
    {
      key: "description",
      label: "Descripción",
      complete: hasDescription,
    },
    {
      key: "specifications",
      label: "Especificaciones",
      complete: activeSpecification,
    },
    { key: "logistics", label: "Peso y medidas", complete: logisticsComplete },
    {
      key: "images",
      label: "Imágenes",
      complete: (primaryVariant?.images.length ?? 0) > 0,
    },
    {
      key: "primaryVariant",
      label: "Variante principal",
      complete: primaryVariantError == null,
    },
    ...(publishing
      ? [{
          key: "activeVariants" as const,
          label: "Variantes activas",
          complete: activeVariantsError == null && activeVariantError == null,
        }]
      : []),
  ]

  const firstError = !input.title.trim()
    ? "Falta completar el título."
    : !input.sku.trim()
      ? "El producto necesita un SKU."
      : !positiveFinite(input.price)
        ? "El precio debe ser mayor a $0."
        : input.categoryId == null || !input.categoryExists
          ? "Seleccioná una categoría."
          : !hasDescription
            ? "Completá la descripción."
            : !activeSpecification
              ? "Agregá al menos una especificación activa."
              : !logisticsComplete
                ? "Completá peso, profundidad, ancho y largo."
                : primaryVariantError ?? activeVariantError ?? activeVariantsError

  return {
    ready: firstError == null,
    firstError,
    requirements,
    primaryVariant,
  }
}
