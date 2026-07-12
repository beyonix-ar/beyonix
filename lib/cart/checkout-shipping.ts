import { getShippingCost } from "@/lib/store-config"

export type CheckoutShippingType = "sucursal" | "domicilio"

export interface CheckoutShippingInput {
  type?: CheckoutShippingType | null
  costReal?: number | null
}

export interface NormalizedCheckoutShipping {
  provider: "andreani"
  type: CheckoutShippingType
  costReal: number
  costCharged: number
  freeShippingApplied: boolean
}

export function normalizeCheckoutShipping(
  shipping: CheckoutShippingInput | null | undefined,
  productsTotal: number,
): NormalizedCheckoutShipping {
  const fallbackCost = getShippingCost(productsTotal)
  const realCost = Number(shipping?.costReal)
  const costReal =
    Number.isFinite(realCost) && realCost > 0 ? realCost : fallbackCost
  const freeShippingApplied = fallbackCost === 0

  return {
    provider: "andreani",
    type: shipping?.type === "sucursal" ? "sucursal" : "domicilio",
    costReal,
    costCharged: freeShippingApplied ? 0 : costReal,
    freeShippingApplied,
  }
}
