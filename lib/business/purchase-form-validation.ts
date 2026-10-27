/**
 * Admin → Compras: reglas de los campos del ingreso de mercadería. Es la
 * fuente única que usan el formulario (qué bloquea el guardado, qué campos se
 * marcan y el mensaje "Falta completar …") y la API (`/api/admin/costs`),
 * para que ambos acepten y rechacen exactamente lo mismo.
 *
 * Clasificación de los campos del formulario:
 * - Numéricos enteros: Cantidad comprada, Cantidad recibida.
 * - Numéricos decimales (importes ≥ 0, hasta 2 decimales): Costo unitario,
 *   Flete y Otros costos. Vacío en Flete/Otros costos = 0.
 * - Solo texto: Nombre del color (letras con tildes/ñ/ü, espacios, guiones,
 *   paréntesis, apóstrofo, barra y punto; sin números).
 * - Alfanuméricos con formato: SKU y Código de barra (letras, números, guion,
 *   punto, guion bajo y barra, sin espacios) y Número de comprobante (además
 *   espacios y #).
 * - Texto libre (puede llevar números): Nombre del artículo ("Pava 12V"),
 *   Proveedor, Comprobante, Medio de pago y Notas.
 */

export type PurchaseFormField =
  | "article"
  | "articleName"
  | "color"
  | "colorName"
  | "barcode"
  | "sku"
  | "purchaseDate"
  | "quantity"
  | "receivedQuantity"
  | "unitCost"
  | "freightCost"
  | "otherCost"
  | "documentNumber"

/** Etiquetas visibles, en el orden del formulario (el mensaje respeta ese orden). */
export const PURCHASE_FIELD_LABELS: Record<PurchaseFormField, string> = {
  article: "Artículo",
  articleName: "Nombre del artículo",
  color: "Color",
  colorName: "Nombre del color",
  barcode: "Código de barra",
  sku: "SKU",
  purchaseDate: "Fecha de compra",
  quantity: "Cantidad comprada",
  receivedQuantity: "Cantidad recibida",
  unitCost: "Costo unitario",
  freightCost: "Flete",
  otherCost: "Otros costos",
  documentNumber: "Número de comprobante",
}

const FIELD_ORDER = Object.keys(PURCHASE_FIELD_LABELS) as PurchaseFormField[]

/** "Falta completar SKU." / "… Costo unitario y Cantidad comprada." / "… SKU, Color y Flete." */
export function formatMissingFieldsMessage(fields: PurchaseFormField[]) {
  const labels = FIELD_ORDER.filter((field) => fields.includes(field)).map((field) => PURCHASE_FIELD_LABELS[field])
  if (!labels.length) return null
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} y ${labels.at(-1)}`
  return `Falta completar ${list}.`
}

// --- Formatos ------------------------------------------------------------------

const INTEGER_PATTERN = /^\d+$/
const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/
const COLOR_HEX_PATTERN = /^#[0-9A-F]{6}$/i
const COLOR_NAME_PATTERN = /^(?=.*\p{L})[\p{L}\p{M} '()\-/.]+$/u
const CODE_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{N}._/-]+$/u
const DOCUMENT_NUMBER_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{N} ._/#-]+$/u

export const isValidColorHex = (value: string) => COLOR_HEX_PATTERN.test(value.trim())
export const isValidColorName = (value: string) => COLOR_NAME_PATTERN.test(value.trim())
export const isValidSku = (value: string) => CODE_PATTERN.test(value.trim())
export const isValidBarcode = (value: string) => CODE_PATTERN.test(value.trim())
export const isValidDocumentNumber = (value: string) => DOCUMENT_NUMBER_PATTERN.test(value.trim())

export const COLOR_FORMAT_MESSAGE = "El color elegido no es válido."
export const COLOR_NAME_FORMAT_MESSAGE =
  "El nombre del color sólo puede tener letras, espacios, guiones o paréntesis (sin números)."
export const SKU_FORMAT_MESSAGE =
  "El SKU sólo puede tener letras, números, guiones, puntos, guiones bajos o barras (sin espacios)."
export const BARCODE_FORMAT_MESSAGE =
  "El código de barra sólo puede tener letras, números, guiones, puntos, guiones bajos o barras (sin espacios)."
export const DOCUMENT_NUMBER_FORMAT_MESSAGE =
  "El número de comprobante sólo puede tener letras, números, espacios y los signos . _ / # -."

export function amountFormatMessage(field: "unitCost" | "freightCost" | "otherCost") {
  return `Revisá ${PURCHASE_FIELD_LABELS[field]}: ingresá un importe válido, mayor o igual a cero.`
}

// --- Sanitizado al escribir/pegar (UI) -------------------------------------------

export const sanitizeInteger = (value: string) => value.replace(/\D/g, "")

/**
 * Importe escrito o pegado → "1234.5". Acepta coma o punto decimal y el
 * formato es-AR con miles ("$ 12.500,50" → "12500.50"); descarta letras y
 * signos (no hay negativos) y deja hasta 2 decimales.
 */
export function sanitizeAmount(value: string) {
  let clean = value.replace(/[^\d.,]/g, "")
  if (clean.includes(",") && clean.includes(".")) {
    clean = clean.replace(/\./g, "").replace(",", ".")
  } else {
    clean = clean.replace(/,/g, ".")
  }
  const [whole, ...decimals] = clean.split(".")
  return decimals.length ? `${whole}.${decimals.join("").slice(0, 2)}` : whole
}

export const sanitizeColorName = (value: string) => value.replace(/[^\p{L}\p{M} '()\-/.]/gu, "")
export const sanitizeCode = (value: string) => value.replace(/[^\p{L}\p{N}._/-]/gu, "")
export const sanitizeDocumentNumber = (value: string) => value.replace(/[^\p{L}\p{N} ._/#-]/gu, "")

// --- Parseo estricto (UI y API) ----------------------------------------------------

/** Entero > 0 ("2" o 2); `null` si falta o no es válido ("1.5", "abc", "-1", "1e3"). */
export function parsePositiveInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && INTEGER_PATTERN.test(value.trim()) ? Number(value.trim()) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** Entero ≥ 0; `null` si no es válido. */
export function parseNonNegativeInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && INTEGER_PATTERN.test(value.trim()) ? Number(value.trim()) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/** ¿El importe vino vacío? (Flete/Otros costos vacíos valen 0; el costo unitario es obligatorio). */
export const isBlankAmount = (value: unknown) => value == null || (typeof value === "string" && value.trim() === "")

/**
 * Importe ≥ 0. Vacío → 0. `null` si no es un número válido: letras,
 * negativos, NaN, Infinity, notación científica o más de 2 decimales.
 */
export function parseAmount(value: unknown) {
  if (isBlankAmount(value)) return 0
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value !== "string" || !AMOUNT_PATTERN.test(value.trim())) return null
  return Number(value.trim())
}

// --- Validación del formulario -----------------------------------------------------

export type PurchaseReceptionStatus = "pendiente" | "parcial" | "recibida" | "anulada"

export interface PurchaseFormInput {
  /** Hay un artículo elegido (catálogo, no catalogado o "Crear artículo nuevo"). */
  hasArticle: boolean
  isNewArticle: boolean
  articleName: string
  /** El color es obligatorio (artículo nuevo / producto con variantes); con `createsVariant` también. */
  colorRequired: boolean
  colorHex: string
  colorName: string
  /** El color/nombre se persiste como variante nueva (ahí se valida el nombre). */
  createsVariant: boolean
  skuRequired: boolean
  sku: string
  /** Código editable por el operador ("" si no se escribe uno). */
  barcode: string
  purchaseDate: string
  quantity: string
  receptionStatus: PurchaseReceptionStatus
  receivedQuantity: string
  unitCost: string
  freightCost: string
  otherCost: string
  documentNumber: string
}

export interface PurchaseFormValidation {
  /** Campos a marcar: los incompletos y los inválidos. */
  fields: PurchaseFormField[]
  /** `null` si se puede guardar. */
  message: string | null
}

export function validatePurchaseForm(input: PurchaseFormInput): PurchaseFormValidation {
  const missing: PurchaseFormField[] = []
  const invalid: { field: PurchaseFormField; message: string }[] = []
  const colorHex = input.colorHex.trim()
  const colorName = input.colorName.trim()
  const sku = input.sku.trim()
  const barcode = input.barcode.trim()

  if (!input.hasArticle) missing.push("article")
  if (input.isNewArticle && !input.articleName.trim()) missing.push("articleName")
  // Variante nueva ⇒ color obligatorio (el negro inicial cuenta como completo).
  if ((input.colorRequired || input.createsVariant) && !colorHex) missing.push("color")
  if (colorHex && !isValidColorHex(colorHex)) invalid.push({ field: "color", message: COLOR_FORMAT_MESSAGE })
  if (colorName && !colorHex) invalid.push({ field: "color", message: "Elegí un color con el selector para poder ponerle nombre." })
  if (input.createsVariant && colorName && !isValidColorName(colorName)) {
    invalid.push({ field: "colorName", message: COLOR_NAME_FORMAT_MESSAGE })
  }
  if (barcode && !isValidBarcode(barcode)) invalid.push({ field: "barcode", message: BARCODE_FORMAT_MESSAGE })
  if (input.skuRequired && !sku) missing.push("sku")
  if (sku && !isValidSku(sku)) invalid.push({ field: "sku", message: SKU_FORMAT_MESSAGE })
  if (!input.purchaseDate) missing.push("purchaseDate")

  const quantity = parsePositiveInteger(input.quantity)
  if (!input.quantity.trim()) missing.push("quantity")
  else if (quantity == null) invalid.push({ field: "quantity", message: "La cantidad comprada debe ser un número entero mayor que cero." })

  if (input.receptionStatus === "parcial") {
    const received = parseNonNegativeInteger(input.receivedQuantity)
    if (!input.receivedQuantity.trim()) missing.push("receivedQuantity")
    else if (received == null || received <= 0 || (quantity != null && received >= quantity)) {
      invalid.push({ field: "receivedQuantity", message: "La recepción parcial debe ser mayor que cero y menor que la cantidad comprada." })
    }
  }

  if (isBlankAmount(input.unitCost)) missing.push("unitCost")
  for (const field of ["unitCost", "freightCost", "otherCost"] as const) {
    if (!isBlankAmount(input[field]) && parseAmount(input[field]) == null) {
      invalid.push({ field, message: amountFormatMessage(field) })
    }
  }

  const documentNumber = input.documentNumber.trim()
  if (documentNumber && !isValidDocumentNumber(documentNumber)) {
    invalid.push({ field: "documentNumber", message: DOCUMENT_NUMBER_FORMAT_MESSAGE })
  }

  const fields = FIELD_ORDER.filter((field) => missing.includes(field) || invalid.some((item) => item.field === field))
  return { fields, message: formatMissingFieldsMessage(missing) ?? invalid[0]?.message ?? null }
}
