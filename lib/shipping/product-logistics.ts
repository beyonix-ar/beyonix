import "server-only"

import {
  parseOptionalProductLogistics,
  PRODUCT_LOGISTICS_FIELDS,
  type ProductLogisticsField,
  type ProductLogisticsValues,
} from "./logistics-validation.ts"

export interface ProductLogisticsSource {
  id: number
  nombre: string
  sku?: string | null
  peso_empaquetado_kg?: number | null
  alto_paquete_cm?: number | null
  ancho_paquete_cm?: number | null
  largo_paquete_cm?: number | null
}

export interface ResolvedProductLogistics {
  pesoKg: number
  altoCm: number
  anchoCm: number
  largoCm: number
}

export class IncompleteProductLogisticsError extends Error {
  readonly productId: number
  readonly variantId: number | null
  readonly missingFields: ProductLogisticsField[]

  constructor(
    product: ProductLogisticsSource,
    variant: ProductLogisticsSource | null | undefined,
    missingFields: ProductLogisticsField[],
  ) {
    const target = variant
      ? `la variante “${variant.nombre}” del producto “${product.nombre}”`
      : `el producto “${product.nombre}”`
    const labels = missingFields.map(
      (field) => PRODUCT_LOGISTICS_FIELDS.find((item) => item.key === field)!.label,
    )

    super(
      `No se puede preparar el envío: ${target} no tiene ${labels.join(", ")}.`,
    )
    this.name = "IncompleteProductLogisticsError"
    this.productId = product.id
    this.variantId = variant?.id ?? null
    this.missingFields = missingFields
  }
}

export function resolveProductLogistics(
  product: ProductLogisticsSource,
  variant?: ProductLogisticsSource | null,
): ResolvedProductLogistics {
  const productValues = parseOptionalProductLogistics(product)
  const variantValues = variant
    ? parseOptionalProductLogistics(variant)
    : ({} as Partial<ProductLogisticsValues>)

  const resolved: ProductLogisticsValues = {
    peso_empaquetado_kg:
      variantValues.peso_empaquetado_kg ?? productValues.peso_empaquetado_kg,
    alto_paquete_cm:
      variantValues.alto_paquete_cm ?? productValues.alto_paquete_cm,
    ancho_paquete_cm:
      variantValues.ancho_paquete_cm ?? productValues.ancho_paquete_cm,
    largo_paquete_cm:
      variantValues.largo_paquete_cm ?? productValues.largo_paquete_cm,
  }

  const missingFields = PRODUCT_LOGISTICS_FIELDS.filter(
    ({ key }) => resolved[key] === null,
  ).map(({ key }) => key)

  if (missingFields.length > 0) {
    throw new IncompleteProductLogisticsError(product, variant, missingFields)
  }

  return {
    pesoKg: resolved.peso_empaquetado_kg!,
    altoCm: resolved.alto_paquete_cm!,
    anchoCm: resolved.ancho_paquete_cm!,
    largoCm: resolved.largo_paquete_cm!,
  }
}
