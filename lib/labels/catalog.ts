import { BEYONIX_PRODUCT_CODE, isPrintableBarcode } from "../barcodes/codes.ts"
import { getColorName } from "../products/variant-color.ts"
import { getProductColorMode, type ProductColorMode } from "../products/color-mode.ts"
import { classifyBarcode, type BarcodeClassification } from "./symbology.ts"

// Datos de catálogo que devuelve /api/admin/labels/catalog (siempre server-side).
export interface LabelCatalogVariant {
  id: number
  name: string
  active: boolean
  stock: number | null
  sku: string | null
  colorHex: string | null
  colorHexSecondary: string | null
  barcode: string | null
}

export interface LabelCatalogAlias {
  barcode: string
  /** null = código del grupo comercial (no identifica una variante física). */
  variantId: number | null
}

export interface LabelCatalogProduct {
  id: number
  name: string
  active: boolean
  sku: string | null
  barcode: string | null
  price: number | null
  randomSale: boolean
  colorMode?: ProductColorMode | null
  variants: LabelCatalogVariant[]
  aliases: LabelCatalogAlias[]
}

export type LabelCodeSource = "principal" | "alias" | "sku"

export interface LabelCodeOption {
  code: string
  source: LabelCodeSource
  classification: BarcodeClassification
}

/** Artículo físico imprimible: una variante, o un producto sin variantes. */
export interface LabelTarget {
  productId: number
  variantId: number | null
  productName: string
  variantLabel: string | null
  colorHex: string | null
  colorHexSecondary: string | null
  sku: string | null
  price: number | null
  active: boolean
  randomSale: boolean
  options: LabelCodeOption[]
  /** Código BEYONIX del artículo (si tiene) o su referencia interna. */
  internalCode: string
}

export const LABEL_CODE_SOURCE_LABELS: Record<LabelCodeSource, string> = {
  principal: "Principal",
  alias: "Equivalente",
  sku: "SKU",
}

const normalize = (code: string) => code.trim().toUpperCase()

function codeOption(code: string | null | undefined, source: LabelCodeSource): LabelCodeOption | null {
  const classification = classifyBarcode(code)
  return classification ? { code: classification.code, source, classification } : null
}

// Principal → equivalentes → SKU (sólo si no repite un código ya listado). El
// SKU se ofrece porque Compras y el armado también lo resuelven al escanear.
function collectOptions(principal: string | null, aliases: readonly string[], sku: string | null) {
  const options: LabelCodeOption[] = []
  const seen = new Set<string>()
  const push = (option: LabelCodeOption | null) => {
    if (!option || seen.has(normalize(option.code))) return
    seen.add(normalize(option.code))
    options.push(option)
  }
  push(codeOption(principal, "principal"))
  aliases.forEach((alias) => push(codeOption(alias, "alias")))
  if (sku?.trim() && isPrintableBarcode(sku.trim())) push(codeOption(sku, "sku"))
  return options
}

export function variantDisplayLabel(variant: Pick<LabelCatalogVariant, "name" | "colorHex" | "colorHexSecondary">) {
  // Una variante bicolor guarda "AZUL / ROSA" en el nombre; el hex primario
  // solo no la describe.
  return variant.colorHexSecondary ? variant.name.trim() || getColorName(variant.colorHex, variant.name) : getColorName(variant.colorHex, variant.name)
}

function internalCodeFor(productId: number, variantId: number | null, codes: readonly string[]) {
  return codes.find((code) => BEYONIX_PRODUCT_CODE.test(code.trim()))?.trim() ?? `#${productId}${variantId ? `-${variantId}` : ""}`
}

// Cada variante es un artículo físico propio, también en venta aleatoria: su
// etiqueta lleva su código y nunca el del grupo. Los alias sin variante de un
// producto con variantes no identifican un color: se informan aparte
// (`groupAliases`) y no se ofrecen para imprimir.
export function buildLabelTargets(product: LabelCatalogProduct): { targets: LabelTarget[]; groupAliases: string[] } {
  const groupAliases = product.aliases.filter((alias) => alias.variantId == null).map((alias) => alias.barcode.trim())
  if (getProductColorMode({ modo_color: product.colorMode, venta_aleatoria: product.randomSale }) === "aleatorio_simple" && product.variants.length === 1) {
    const variant = product.variants[0]
    const options = collectOptions(product.barcode ?? variant.barcode, [
      ...(product.barcode && variant.barcode ? [variant.barcode] : []),
      ...groupAliases,
      ...product.aliases.filter((alias) => alias.variantId === variant.id).map((alias) => alias.barcode),
    ], product.sku ?? variant.sku)
    return {
      groupAliases: [],
      targets: [{
        productId: product.id,
        variantId: variant.id,
        productName: product.name,
        variantLabel: "ALEATORIO",
        colorHex: null,
        colorHexSecondary: null,
        sku: product.sku?.trim() || variant.sku?.trim() || null,
        price: product.price,
        active: product.active && variant.active,
        randomSale: false,
        options,
        internalCode: internalCodeFor(product.id, variant.id, options.map((option) => option.code)),
      }],
    }
  }
  if (!product.variants.length) {
    const options = collectOptions(product.barcode, groupAliases, product.sku)
    return {
      groupAliases: [],
      targets: [{
        productId: product.id,
        variantId: null,
        productName: product.name,
        variantLabel: null,
        colorHex: null,
        colorHexSecondary: null,
        sku: product.sku?.trim() || null,
        price: product.price,
        active: product.active,
        randomSale: product.randomSale,
        options,
        internalCode: internalCodeFor(product.id, null, options.map((option) => option.code)),
      }],
    }
  }
  return {
    groupAliases,
    targets: product.variants.map((variant) => {
      const aliases = product.aliases.filter((alias) => alias.variantId === variant.id).map((alias) => alias.barcode)
      const options = collectOptions(variant.barcode, aliases, variant.sku)
      return {
        productId: product.id,
        variantId: variant.id,
        productName: product.name,
        variantLabel: variantDisplayLabel(variant),
        colorHex: variant.colorHex,
        colorHexSecondary: variant.colorHexSecondary,
        sku: variant.sku?.trim() || null,
        price: product.price,
        active: product.active && variant.active,
        randomSale: product.randomSale,
        options,
        internalCode: internalCodeFor(product.id, variant.id, options.map((option) => option.code)),
      }
    }),
  }
}
