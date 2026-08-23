export const COLOR_NAMES_BY_HEX: Record<string, string> = {
  "#000000": "NEGRO",
  "#18181B": "NEGRO MATE",
  "#FFFFFF": "BLANCO",
  "#6B7280": "GRIS",
  "#D1D5DB": "GRIS CLARO",
  "#374151": "GRIS OSCURO",
  "#2563EB": "AZUL",
  "#38BDF8": "CELESTE",
  "#EF4444": "ROJO",
  "#22C55E": "VERDE",
  "#FACC15": "AMARILLO",
}

const GENERIC_VARIANT_NAME = /^(principal|variante(?:\s+\d+)?)$/i
// Coincide con el formato que genera `deriveVariantNameFromColor` (p. ej.
// "COLOR #C9A3B0") cuando no se cargó un nombre de color real: es un valor
// técnico pensado para persistencia/compatibilidad, no para mostrárselo tal
// cual a un cliente.
const AUTO_DERIVED_COLOR_NAME = /^color\s+#[0-9a-f]{6}$/i
const GENERIC_COLOR_LABEL = "COLOR PERSONALIZADO"

export function getColorName(
  colorHex: string | null | undefined,
  variantName?: string | null,
) {
  const normalizedHex = colorHex?.trim().toUpperCase() || ""
  const knownName = COLOR_NAMES_BY_HEX[normalizedHex]
  if (knownName) return knownName

  const cleanVariantName = variantName?.trim() || ""
  const isRealName =
    cleanVariantName &&
    !GENERIC_VARIANT_NAME.test(cleanVariantName) &&
    !AUTO_DERIVED_COLOR_NAME.test(cleanVariantName)

  if (isRealName) return cleanVariantName

  return GENERIC_COLOR_LABEL
}

const HEX_PATTERN = /^#[0-9A-F]{6}$/

/**
 * producto_variantes.nombre ya no es un dato editable por el admin: una
 * variante se identifica por color/SKU/asignación/imágenes, nunca por un
 * nombre propio (ver lib/products/variant-color.md conceptualmente — el
 * nombre visible siempre es producto.nombre). Esta función es la única
 * fuente de verdad para derivar el valor que igual se persiste en esa
 * columna (por compatibilidad con el resto del sistema, que la usa como
 * calificador de color: selector de variantes, compras, ventas, etc.).
 * A diferencia de getColorName, no acepta un nombre libre como fallback:
 * un hex sin nombre conocido se identifica por su propio código para que
 * dos colores personalizados distintos del mismo producto no colisionen
 * con el guardia de identidad duplicada (prevent_duplicate_product_variant_identity).
 */
export function deriveVariantNameFromColor(colorHex: string | null | undefined) {
  const normalizedHex = colorHex?.trim().toUpperCase() || ""
  const knownName = COLOR_NAMES_BY_HEX[normalizedHex]
  if (knownName) return knownName

  return HEX_PATTERN.test(normalizedHex)
    ? `COLOR ${normalizedHex}`
    : GENERIC_COLOR_LABEL
}

function titleCaseAbbreviation(word: string) {
  const accentPattern = new RegExp("[\\u0300-\\u036f]", "g")
  const withoutAccents = word.normalize("NFD").replace(accentPattern, "")
  const letters = withoutAccents.replace(/[^a-zA-Z]/g, "")

  if (letters.length < 2) return null

  const abbreviation = letters.slice(0, 3)
  return abbreviation.charAt(0).toUpperCase() + abbreviation.slice(1).toLowerCase()
}

/**
 * Abreviatura legible y estable de ~3 caracteres para usar en SKUs
 * (Negro → Neg, Blanco → Bla, ...). Se deriva del nombre de color ya
 * resuelto por getColorName, así que cualquier color con nombre legible
 * (conocido o el propio nombre de la variante) produce una abreviatura
 * consistente sin necesitar una segunda tabla. Para colores realmente sin
 * nombre, cae a un código determinístico basado en el hex.
 */
export function getColorAbbreviation(
  colorHex: string | null | undefined,
  variantName?: string | null,
) {
  const resolvedName = getColorName(colorHex, variantName)

  if (resolvedName !== GENERIC_COLOR_LABEL) {
    const firstWord = resolvedName.trim().split(/\s+/)[0] ?? ""
    const abbreviation = titleCaseAbbreviation(firstWord)
    if (abbreviation) return abbreviation
  }

  const normalizedHex = (colorHex?.trim().replace("#", "").toUpperCase() || "")
    .padEnd(6, "0")
    .slice(0, 6)
  return `C${normalizedHex[0]}${normalizedHex[2]}`
}

const MAX_SUGGESTED_SKU_LENGTH = 120
const MAX_BASE_SKU_SEGMENT = 96

function sanitizeSkuSegment(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-]/g, "")
}

/**
 * SKU sugerido para una variante con descuento:
 * <SKU original>-<abreviatura de color>-<% de descuento entero>.
 * Es sólo una sugerencia inicial: el administrador puede sobrescribirla y,
 * una vez editada a mano, no se vuelve a generar automáticamente.
 */
export function buildDiscountedSkuSuggestion({
  originalSku,
  colorHex,
  colorName,
  discountPercent,
}: {
  originalSku?: string | null
  colorHex: string | null | undefined
  colorName?: string | null
  discountPercent: number
}) {
  const base = sanitizeSkuSegment(originalSku || "COND").slice(
    0,
    MAX_BASE_SKU_SEGMENT,
  ) || "COND"
  const colorAbbreviation = getColorAbbreviation(colorHex, colorName)
  const safePercent = Number.isFinite(discountPercent)
    ? Math.min(99, Math.max(0, Math.round(discountPercent)))
    : 0

  return `${base}-${colorAbbreviation}-${safePercent}`.slice(
    0,
    MAX_SUGGESTED_SKU_LENGTH,
  )
}
