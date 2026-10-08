/** Código de barra equivalente de un producto (catalog_barcode_aliases). */
export interface BarcodeAlias {
  barcode: string
  /** Variante física que identifica; null = código del grupo (todos los colores). */
  variantId: number | null
  variantName: string | null
  createdAt: string
}

export const BARCODE_ALIAS_CONFLICT_MESSAGE = "Este código ya está asociado a otro artículo."
