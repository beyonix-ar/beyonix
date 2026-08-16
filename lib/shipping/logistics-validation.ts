export const PRODUCT_LOGISTICS_LIMITS = {
  peso_empaquetado_kg: 10_000,
  alto_paquete_cm: 1_000,
  ancho_paquete_cm: 1_000,
  largo_paquete_cm: 1_000,
} as const

export type ProductLogisticsField = keyof typeof PRODUCT_LOGISTICS_LIMITS

export interface ProductLogisticsValues {
  peso_empaquetado_kg: number | null
  alto_paquete_cm: number | null
  ancho_paquete_cm: number | null
  largo_paquete_cm: number | null
}

export const PRODUCT_LOGISTICS_FIELDS: ReadonlyArray<{
  key: ProductLogisticsField
  label: string
  unit: "kg" | "cm"
}> = [
  { key: "peso_empaquetado_kg", label: "Peso empaquetado", unit: "kg" },
  { key: "alto_paquete_cm", label: "Alto", unit: "cm" },
  { key: "ancho_paquete_cm", label: "Ancho", unit: "cm" },
  { key: "largo_paquete_cm", label: "Largo", unit: "cm" },
]

export class ProductLogisticsValidationError extends Error {
  readonly field: ProductLogisticsField

  constructor(field: ProductLogisticsField, message: string) {
    super(message)
    this.name = "ProductLogisticsValidationError"
    this.field = field
  }
}

function fieldDefinition(field: ProductLogisticsField) {
  return PRODUCT_LOGISTICS_FIELDS.find((item) => item.key === field)!
}

export function parseOptionalLogisticsValue(
  value: unknown,
  field: ProductLogisticsField,
): number | null {
  if (value === null || value === undefined || value === "") return null

  const normalized =
    typeof value === "string" ? value.trim().replace(",", ".") : value
  if (normalized === "") return null

  const parsed = Number(normalized)
  const definition = fieldDefinition(field)
  const maximum = PRODUCT_LOGISTICS_LIMITS[field]

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ProductLogisticsValidationError(
      field,
      `${definition.label} debe ser un número mayor que 0 ${definition.unit}.`,
    )
  }

  if (parsed > maximum) {
    throw new ProductLogisticsValidationError(
      field,
      `${definition.label} no puede superar ${maximum.toLocaleString("es-AR")} ${definition.unit}.`,
    )
  }

  return parsed
}

export function parseOptionalProductLogistics(values: {
  peso_empaquetado_kg?: unknown
  alto_paquete_cm?: unknown
  ancho_paquete_cm?: unknown
  largo_paquete_cm?: unknown
}): ProductLogisticsValues {
  return {
    peso_empaquetado_kg: parseOptionalLogisticsValue(
      values.peso_empaquetado_kg,
      "peso_empaquetado_kg",
    ),
    alto_paquete_cm: parseOptionalLogisticsValue(
      values.alto_paquete_cm,
      "alto_paquete_cm",
    ),
    ancho_paquete_cm: parseOptionalLogisticsValue(
      values.ancho_paquete_cm,
      "ancho_paquete_cm",
    ),
    largo_paquete_cm: parseOptionalLogisticsValue(
      values.largo_paquete_cm,
      "largo_paquete_cm",
    ),
  }
}

export interface RequiredProductLogisticsValues {
  peso_empaquetado_kg: number
  alto_paquete_cm: number
  ancho_paquete_cm: number
  largo_paquete_cm: number
}

/**
 * Variante obligatoria para la ficha del producto (peso y dimensiones del
 * paquete son datos comerciales requeridos, a diferencia de la sobrescritura
 * opcional por variante que sigue usando parseOptionalProductLogistics).
 */
export function parseRequiredLogisticsValue(
  value: unknown,
  field: ProductLogisticsField,
): number {
  const parsed = parseOptionalLogisticsValue(value, field)

  if (parsed === null) {
    const definition = fieldDefinition(field)
    throw new ProductLogisticsValidationError(
      field,
      `${definition.label} es obligatorio.`,
    )
  }

  return parsed
}

export function parseRequiredProductLogistics(values: {
  peso_empaquetado_kg?: unknown
  alto_paquete_cm?: unknown
  ancho_paquete_cm?: unknown
  largo_paquete_cm?: unknown
}): RequiredProductLogisticsValues {
  return {
    peso_empaquetado_kg: parseRequiredLogisticsValue(
      values.peso_empaquetado_kg,
      "peso_empaquetado_kg",
    ),
    alto_paquete_cm: parseRequiredLogisticsValue(
      values.alto_paquete_cm,
      "alto_paquete_cm",
    ),
    ancho_paquete_cm: parseRequiredLogisticsValue(
      values.ancho_paquete_cm,
      "ancho_paquete_cm",
    ),
    largo_paquete_cm: parseRequiredLogisticsValue(
      values.largo_paquete_cm,
      "largo_paquete_cm",
    ),
  }
}

export function normalizeLogisticsDecimalInput(value: string) {
  const cleaned = value.replace(/[^\d,.]/g, "")
  const separatorIndex = cleaned.search(/[,.]/)
  if (separatorIndex < 0) return cleaned

  return `${cleaned.slice(0, separatorIndex + 1)}${cleaned
    .slice(separatorIndex + 1)
    .replace(/[,.]/g, "")}`
}
