// Jerarquía de códigos BEYONIX (texto plano, Code 128):
//   producto/variante  BX-AUR-000001      (o EAN/UPC del fabricante)
//   bulto              BX-PKG-1050-02     (BX-PKG-1050-R2-02 en un rearmado)
//   lote de envío      DSP-20261007-001
// Las reglas de unicidad viven en la base (catalog_barcode_registry,
// order_package_parcels.barcode, dispatch_batches.code).

export type BarcodeOrigin = "fabricante" | "beyonix"

export const BEYONIX_PRODUCT_CODE = /^BX-[A-Z]{3}-\d{6,}$/
export const PARCEL_CODE = /^BX-PKG-\d+(?:-R\d+)?-\d{2}$/
export const BATCH_CODE = /^DSP-\d{8}-\d{3,}$/

// Code 128 codifica ASCII imprimible; el resto de los códigos de catálogo se
// imprime igual que se escanea.
const PRINTABLE_CODE = /^[\x21-\x7E](?:[\x20-\x7E]{0,62}[\x21-\x7E])?$/

export function isPrintableBarcode(code: string) {
  return PRINTABLE_CODE.test(code)
}

export function barcodeOrigin(code: string | null | undefined): BarcodeOrigin | null {
  const value = code?.trim()
  if (!value) return null
  return BEYONIX_PRODUCT_CODE.test(value) ? "beyonix" : "fabricante"
}

export function barcodeOriginLabel(origin: BarcodeOrigin | null) {
  return origin === "beyonix" ? "BEYONIX" : origin === "fabricante" ? "Fabricante" : "Código pendiente"
}

export function isReservedProductBarcode(code: string) {
  return /^(BX-PKG-|DSP-)/i.test(code.trim())
}
