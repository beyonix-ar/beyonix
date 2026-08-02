import {
  calculateCustomerShippingCost,
  DEFAULT_SHIPPING_SETTINGS,
  type ShippingBonusSettings,
} from "../store-config.ts"

export type CheckoutShippingType = "sucursal" | "domicilio"

export interface CheckoutShippingInput {
  type?: CheckoutShippingType | null
  costReal?: number | null
  quoted?: boolean
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
  const realCost = Number(shipping?.costReal)
  const quoted = shipping?.quoted === true
  if (quoted && (!Number.isFinite(realCost) || realCost <= 0)) {
    throw new Error("La cotización de envío no tiene un importe válido.")
  }
  const costReal = quoted ? realCost : 0
  const costCharged = !quoted || options.customerCreditApplied
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
