/**
 * Composición adaptativa de la etiqueta Envío BEYONIX (101,6 × 50,8 mm).
 *
 * Ningún dato de entrega se corta: nada de ellipsis, line-clamp ni alturas
 * que oculten texto. Los textos se ajustan por escalones de tamaño (de mayor
 * a menor, siempre legibles) y se elige el primero en el que todo entra. Si ni
 * el escalón mínimo alcanza, la etiqueta NO se genera: se pide revisar los
 * datos antes de imprimir.
 *
 * La estimación usa métricas de Arial Bold (las de Liberation Sans son
 * idénticas) para TODOS los campos, con margen de seguridad: si estima que
 * entra, entra. Además, la impresión vuelve a medir en el navegador
 * (findClippedLocalDeliveryLabel) y no imprime si algo quedara cortado.
 */

export const LOCAL_DELIVERY_LABEL_TOO_LONG =
  "Los datos de entrega son demasiado largos para esta etiqueta. Revisalos antes de imprimir."

/** Tamaños en pt de cada campo y alto de línea (unitario) de un escalón. */
export interface LocalDeliveryLabelLayout {
  address: number
  reference: number
  recipient: number
  phone: number
  city: number
  lineHeight: number
}

/** De mayor a menor. Mínimo legible en térmica 203 dpi: 7 pt (referencia 6,5 pt). */
export const LOCAL_DELIVERY_LABEL_TIERS: readonly LocalDeliveryLabelLayout[] = [
  { address: 11, reference: 8.5, recipient: 10, phone: 10.5, city: 9, lineHeight: 1.12 },
  { address: 10, reference: 8, recipient: 9.5, phone: 10, city: 8.5, lineHeight: 1.12 },
  { address: 9, reference: 7.5, recipient: 9, phone: 9, city: 8, lineHeight: 1.1 },
  { address: 8.5, reference: 7.5, recipient: 8.5, phone: 8.5, city: 7.5, lineHeight: 1.08 },
  { address: 8, reference: 7, recipient: 8, phone: 8, city: 7.5, lineHeight: 1.06 },
  { address: 7.5, reference: 7, recipient: 7.5, phone: 7.5, city: 7, lineHeight: 1.05 },
  { address: 7, reference: 6.5, recipient: 7, phone: 7, city: 7, lineHeight: 1.05 },
]

/**
 * Geometría en mm (la usa el CSS de la etiqueta: misma fuente de verdad).
 * Alto: 1,2 + 5,4 (cabecera) + 0,6 + 29,2 (cuerpo) + 0,6 + 9 (barras) + 0,6 + 3 (código) + 1,2 = 50,8.
 * QR de gestión de entrega del pedido, dos ubicaciones (nunca se sacrifica un
 * dato de entrega para meterlo):
 * - "side" (preferida): 18 mm a la derecha de los datos, separado 1,5 mm; el
 *   ancho útil de los textos descuenta esa columna.
 * - "footer" (sólo si los datos no entran al lado del QR): 12,6 mm a la
 *   derecha de las barras y el código, y los datos recuperan el ancho completo.
 */
export const LOCAL_DELIVERY_LABEL_GEOMETRY = {
  paddingBlockMm: 1.2,
  paddingInlineMm: 2.5,
  headHeightMm: 5.4,
  sectionGapMm: 0.6,
  bodyHeightMm: 29.2,
  barcodeHeightMm: 9,
  barcodeQuietZoneMm: 7,
  footHeightMm: 3,
  fieldLabelWidthMm: 14,
  fieldLabelPt: 5,
  columnGapMm: 1.5,
  rowGapMm: 0.5,
  qrSizeMm: 18,
  qrGapMm: 1.5,
  qrCaptionPt: 5,
  qrFooterSizeMm: 12.6,
} as const

export type LocalDeliveryQrPlacement = "side" | "footer"

/** Escalón de textos elegido y ubicación del QR. */
export interface LocalDeliveryLabelFit extends LocalDeliveryLabelLayout {
  qr: LocalDeliveryQrPlacement
}

const G = LOCAL_DELIVERY_LABEL_GEOMETRY
const PT_TO_MM = 25.4 / 72
const FULL_VALUE_WIDTH_MM = 101.6 - 2 * G.paddingInlineMm - G.fieldLabelWidthMm - G.columnGapMm
/** Margen de seguridad: ancho útil al 94 % y 0,8 mm de alto libre. */
const WRAP_WIDTH_MM: Record<LocalDeliveryQrPlacement, number> = {
  side: (FULL_VALUE_WIDTH_MM - G.qrSizeMm - G.qrGapMm) * 0.94,
  footer: FULL_VALUE_WIDTH_MM * 0.94,
}
const HEIGHT_BUDGET_MM = G.bodyHeightMm - 0.8

// Anchos de Arial Bold en milésimas de em. Letras acentuadas = su base.
const CHAR_WIDTHS = new Map<string, number>()
const widths: Array<[string, number]> = [
  [" ", 278], ["ijl.,'|\\", 278], ["fIt()[]-!:;", 333], ["r*", 389], ["\"", 474], ["z", 500],
  ["acesvxykJ0123456789$#_", 556], ["bdghnopquFLTZ?", 611], ["ESPVXY", 667],
  ["ABCDHKNRU&", 722], ["w", 778], ["GOQ", 778], ["M", 833], ["m%", 889], ["W", 944], ["@", 975],
  ["°", 400], ["º", 365], ["ª", 370], ["+<=>", 584],
]
for (const [chars, width] of widths) for (const char of chars) CHAR_WIDTHS.set(char, width)
/** Cualquier carácter sin métrica conocida se toma como 1 em (conservador). */
const UNKNOWN_WIDTH = 1000

function charWidthEm(char: string) {
  const known = CHAR_WIDTHS.get(char) ?? CHAR_WIDTHS.get(char.normalize("NFD").replace(/\p{M}/gu, ""))
  return (known ?? UNKNOWN_WIDTH) / 1000
}

/** Líneas que ocupa `text` en `widthMm` a `fontPt` (corte por palabras; una palabra más larga que la línea se parte). */
export function estimateLabelLines(text: string, fontPt: number, widthMm = WRAP_WIDTH_MM.side) {
  const maxEm = widthMm / (fontPt * PT_TO_MM)
  const space = charWidthEm(" ")
  let lines = 1
  let current = 0
  for (const word of text.split(" ").filter(Boolean)) {
    const wordEm = [...word].reduce((total, char) => total + charWidthEm(char), 0)
    const gap = current > 0 ? space : 0
    if (current + gap + wordEm <= maxEm) {
      current += gap + wordEm
      continue
    }
    if (current > 0) {
      lines += 1
      current = 0
    }
    for (const char of word) {
      const width = charWidthEm(char)
      if (current > 0 && current + width > maxEm) {
        lines += 1
        current = 0
      }
      current += width
    }
  }
  return lines
}

export interface LocalDeliveryLabelFields {
  recipient: string
  address: string
  reference: string | null
  locality: string
  province: string | null
  postalCode: string
  phone: string | null
}

export function localDeliveryCityLine(fields: Pick<LocalDeliveryLabelFields, "locality" | "province" | "postalCode">) {
  return `${[fields.locality, fields.province].filter(Boolean).join(", ")} · CP ${fields.postalCode}`
}

const LOCAL_DELIVERY_NO_PHONE = "—"
export const localDeliveryPhoneText = (phone: string | null) => phone ?? LOCAL_DELIVERY_NO_PHONE

/** Alto estimado (mm) del cuerpo con un escalón dado. */
export function estimateLocalDeliveryBodyHeight(fields: LocalDeliveryLabelFields, layout: LocalDeliveryLabelLayout, qr: LocalDeliveryQrPlacement = "side") {
  const width = WRAP_WIDTH_MM[qr]
  const labelRow = G.fieldLabelPt * PT_TO_MM * 1.1
  const row = (text: string, fontPt: number) =>
    Math.max(labelRow, estimateLabelLines(text, fontPt, width) * fontPt * PT_TO_MM * layout.lineHeight)
  const rows = [
    row(fields.recipient, layout.recipient),
    row(fields.address, layout.address),
    ...(fields.reference ? [row(fields.reference, layout.reference)] : []),
    row(localDeliveryCityLine(fields), layout.city),
    row(localDeliveryPhoneText(fields.phone), layout.phone),
  ]
  return rows.reduce((total, height) => total + height, 0) + G.rowGapMm * (rows.length - 1)
}

/** El escalón más grande en el que entra todo; `null` si ni el mínimo alcanza. */
export function fitLocalDeliveryLabel(fields: LocalDeliveryLabelFields): LocalDeliveryLabelFit | null {
  for (const qr of ["side", "footer"] as const) {
    const layout = LOCAL_DELIVERY_LABEL_TIERS.find((tier) => estimateLocalDeliveryBodyHeight(fields, tier, qr) <= HEIGHT_BUDGET_MM)
    if (layout) return { ...layout, qr }
  }
  return null
}
