interface ShippingPackageItem {
  product: object
  quantity: number
}

export interface ShippingPackage {
  pesoGramos: number
  altoCm: number
  anchoCm: number
  largoCm: number
  valorDeclarado: number
}

const FALLBACK_WEIGHT_GRAMS = 500
const FALLBACK_HEIGHT_CM = 10
const FALLBACK_WIDTH_CM = 15
const FALLBACK_LENGTH_CM = 20

function toPositiveNumber(value: unknown, fallback: number) {
  const numberValue = Number(value)

  return Number.isFinite(numberValue) && numberValue > 0
    ? numberValue
    : fallback
}

export function calculateCartShippingPackage(
  items: ShippingPackageItem[]
): ShippingPackage {
  const totals = items.reduce(
    (acc, item) => {
      const quantity = Math.max(Math.trunc(Number(item.quantity) || 0), 0)
      const product = item.product as Record<string, unknown>

      // Fallback seguro hasta que los productos tengan peso y medidas reales.
      const weight = toPositiveNumber(product.peso_gramos, FALLBACK_WEIGHT_GRAMS)
      const height = toPositiveNumber(product.alto_cm, FALLBACK_HEIGHT_CM)
      const width = toPositiveNumber(product.ancho_cm, FALLBACK_WIDTH_CM)
      const length = toPositiveNumber(product.largo_cm, FALLBACK_LENGTH_CM)
      const price = toPositiveNumber(product.precio, 0)

      return {
        pesoGramos: acc.pesoGramos + weight * quantity,
        altoCm: Math.max(acc.altoCm, height),
        anchoCm: Math.max(acc.anchoCm, width),
        largoCm: acc.largoCm + length * quantity,
        valorDeclarado: acc.valorDeclarado + price * quantity,
      }
    },
    {
      pesoGramos: 0,
      altoCm: 0,
      anchoCm: 0,
      largoCm: 0,
      valorDeclarado: 0,
    }
  )

  return {
    pesoGramos: Math.max(totals.pesoGramos, FALLBACK_WEIGHT_GRAMS),
    altoCm: Math.max(totals.altoCm, FALLBACK_HEIGHT_CM),
    anchoCm: Math.max(totals.anchoCm, FALLBACK_WIDTH_CM),
    largoCm: Math.max(totals.largoCm, FALLBACK_LENGTH_CM),
    valorDeclarado: Math.max(totals.valorDeclarado, 1),
  }
}
