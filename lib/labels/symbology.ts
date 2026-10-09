import { BEYONIX_PRODUCT_CODE, isPrintableBarcode } from "../barcodes/codes.ts"

// Simbología con la que se imprime un código. Sólo se imprime como EAN/UPC un
// número que ya es un GTIN válido (largo + dígito verificador): nunca se
// inventa ni se "corrige" un EAN. El resto va en Code 128, que codifica el
// texto tal cual se escanea.
export type LabelSymbology = "ean13" | "ean8" | "upca" | "code128"

export type BarcodeKind = "ean13" | "ean8" | "upca" | "beyonix" | "code128"

export interface BarcodeClassification {
  code: string
  kind: BarcodeKind
  symbology: LabelSymbology
  label: string
  /** Aviso no bloqueante (p. ej. números con dígito verificador inválido). */
  notice: string | null
}

export const SYMBOLOGY_LABELS: Record<LabelSymbology, string> = {
  ean13: "EAN-13",
  ean8: "EAN-8",
  upca: "UPC-A",
  code128: "Code 128",
}

const KIND_LABELS: Record<BarcodeKind, string> = {
  ean13: "EAN-13",
  ean8: "EAN-8",
  upca: "UPC-A",
  beyonix: "Interno BEYONIX · Code 128",
  code128: "Code 128",
}

// Zona silenciosa mínima (en módulos) a cada lado, según GS1 / ISO 15417.
export const QUIET_ZONE_MODULES: Record<LabelSymbology, { left: number; right: number }> = {
  ean13: { left: 11, right: 7 },
  ean8: { left: 7, right: 7 },
  upca: { left: 9, right: 9 },
  code128: { left: 10, right: 10 },
}

// Ancho de módulo mínimo recomendado para lectura confiable. EAN/UPC: 80 % del
// nominal de 0,33 mm (límite inferior GS1). Code 128: 0,25 mm (≈ 10 mil) para
// impresoras térmicas y de escritorio.
export const MIN_MODULE_MM: Record<LabelSymbology, number> = {
  ean13: 0.264,
  ean8: 0.264,
  upca: 0.264,
  code128: 0.25,
}

export function gtinCheckDigit(body: string) {
  let sum = 0
  for (let index = 0; index < body.length; index += 1) {
    const digit = body.charCodeAt(body.length - 1 - index) - 48
    sum += digit * (index % 2 === 0 ? 3 : 1)
  }
  return (10 - (sum % 10)) % 10
}

export function isValidGtin(code: string, length: 8 | 12 | 13) {
  if (code.length !== length || !/^\d+$/.test(code)) return false
  return gtinCheckDigit(code.slice(0, -1)) === Number(code[code.length - 1])
}

function result(code: string, kind: BarcodeKind, notice: string | null = null): BarcodeClassification {
  const symbology: LabelSymbology = kind === "beyonix" ? "code128" : kind
  return { code, kind, symbology, label: KIND_LABELS[kind], notice }
}

/** null si el código no se puede imprimir (vacío o fuera de ASCII imprimible). */
export function classifyBarcode(raw: string | null | undefined): BarcodeClassification | null {
  const code = raw?.trim() ?? ""
  if (!code || !isPrintableBarcode(code)) return null
  if (BEYONIX_PRODUCT_CODE.test(code)) return result(code, "beyonix")
  if (isValidGtin(code, 13)) return result(code, "ean13")
  if (isValidGtin(code, 12)) return result(code, "upca")
  if (isValidGtin(code, 8)) return result(code, "ean8")
  if (/^\d{8}$|^\d{12,13}$/.test(code)) {
    return result(code, "code128", "El número no tiene un dígito verificador EAN/UPC válido: se imprime en Code 128 tal cual está cargado.")
  }
  return result(code, "code128")
}
