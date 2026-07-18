import {
  calculateCustomerShippingCost,
  DEFAULT_SHIPPING_SETTINGS,
  SHIPPING_COST,
  type ShippingBonusSettings,
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
  options: {
    customerCreditApplied?: boolean
    settings?: Partial<ShippingBonusSettings> | null
  } = {},
): NormalizedCheckoutShipping {
  const fallbackCost =
    Number.isFinite(options.settings?.defaultShippingCost) &&
    Number(options.settings?.defaultShippingCost) >= 0
      ? Number(options.settings?.defaultShippingCost)
      : SHIPPING_COST
  const realCost = Number(shipping?.costReal)
  const costReal =
    Number.isFinite(realCost) && realCost > 0 ? realCost : fallbackCost
  const costCharged = options.customerCreditApplied
    ? 0
    : calculateCustomerShippingCost(
        productsTotal,
        costReal,
        options.settings ?? DEFAULT_SHIPPING_SETTINGS,
      )
  const freeShippingApplied = costReal > 0 && costCharged === 0

  return {
    provider: "andreani",
    type: shipping?.type === "sucursal" ? "sucursal" : "domicilio",
    costReal,
    costCharged,
    freeShippingApplied,
  }
}
