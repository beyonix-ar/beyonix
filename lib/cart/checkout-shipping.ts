import {
  calculateCustomerShippingCost,
  SHIPPING_COST,
} from "@/lib/store-config"

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
  const fallbackCost = SHIPPING_COST
  const realCost = Number(shipping?.costReal)
  const costReal =
    Number.isFinite(realCost) && realCost > 0 ? realCost : fallbackCost
  const costCharged = calculateCustomerShippingCost(productsTotal, costReal)
  const freeShippingApplied = costReal > 0 && costCharged === 0

  return {
    provider: "andreani",
    type: shipping?.type === "sucursal" ? "sucursal" : "domicilio",
    costReal,
    costCharged,
    freeShippingApplied,
  }
}
