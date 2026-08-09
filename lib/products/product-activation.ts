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
  assignedStock: number
}

export interface ProductActivationInput {
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

export function getVariantActivationError(
  variant: ProductActivationVariant,
  principal = false,
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
  const logisticsComplete = Object.values(input.logistics).every(positiveFinite)
  const primaryVariantError = primaryVariant
    ? getVariantActivationError(primaryVariant, true)
    : "Creá al menos una variante."
  const activeVariants = input.variants.filter((variant) => variant.active === true)
  const activeVariantError = activeVariants
    .map((variant) => getVariantActivationError(variant))
    .find((error): error is string => error != null) ?? null

  const requirements: ProductActivationRequirement[] = [
    { key: "title", label: "Título", complete: Boolean(input.title.trim()) },
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
      complete: Boolean(input.description.trim()),
    },
    {
      key: "specifications",
      label: "Especificaciones",
      complete: activeSpecification,
    },
    { key: "logistics", label: "Dimensiones", complete: logisticsComplete },
    {
      key: "primaryVariant",
      label: "Variante principal",
      complete: primaryVariantError == null,
    },
    {
      key: "activeVariants",
      label: "Variante activa",
      complete: activeVariants.length > 0 && activeVariantError == null,
    },
  ]

  const firstError = !input.title.trim()
    ? "Falta completar el título."
    : !input.sku.trim()
      ? "El producto necesita un SKU."
      : !positiveFinite(input.price)
        ? "El precio debe ser mayor a $0."
        : input.categoryId == null || !input.categoryExists
          ? "Seleccioná una categoría."
          : !input.description.trim()
            ? "Completá la descripción."
            : !activeSpecification
              ? "Agregá al menos una especificación activa."
              : !logisticsComplete
                ? "Completá peso, profundidad, ancho y largo."
                : primaryVariantError ??
                  (activeVariants.length === 0
                    ? "Activá al menos una variante."
                    : activeVariantError)

  return {
    ready: firstError == null,
    firstError,
    requirements,
    primaryVariant,
  }
}
