import { SITE_SETTINGS } from "@/config/site-settings"

// Envio gratis a partir de este subtotal.
const configuredFreeShippingMin = Number(
  process.env.NEXT_PUBLIC_FREE_SHIPPING_MIN_AMOUNT ??
    process.env.FREE_SHIPPING_MIN_AMOUNT,
)

export const FREE_SHIPPING_MIN =
  Number.isFinite(configuredFreeShippingMin) && configuredFreeShippingMin >= 0
    ? configuredFreeShippingMin
    : SITE_SETTINGS.shipping.freeShippingMinAmount

export type FreeShippingMode = "full" | "off"

function getFreeShippingMode(): FreeShippingMode {
  const configuredMode =
    process.env.NEXT_PUBLIC_FREE_SHIPPING_MODE ??
    process.env.FREE_SHIPPING_MODE

  if (configuredMode === "full" || configuredMode === "off") {
    return configuredMode
  }

  return SITE_SETTINGS.shipping.freeShippingMode === "full" ? "full" : "off"
}

export const FREE_SHIPPING_MODE = getFreeShippingMode()
export const IS_FREE_SHIPPING_ENABLED = getFreeShippingMode() === "full"

// Costo de envio al cliente cuando no supera el minimo.
export const SHIPPING_COST = SITE_SETTINGS.shipping.defaultShippingCost

export function getShippingCost(subtotal: number) {
  const safeSubtotal = Number.isFinite(subtotal) ? subtotal : 0

  return safeSubtotal >= FREE_SHIPPING_MIN && IS_FREE_SHIPPING_ENABLED
    ? 0
    : SHIPPING_COST
}

export function hasFreeShipping(subtotal: number) {
  return getShippingCost(subtotal) === 0
}

// DESCUENTO DE TRANSFERENCIA: 10%
export const TRANSFER_DISCOUNT = 0.10

// TEXTO AUTOMATICO DEL DESCUENTO (se actualiza solo)
export const TRANSFER_DISCOUNT_LABEL = `${TRANSFER_DISCOUNT * 100}%`

// ================================
// CAMPANAS FUTURAS
// SOLO UNA DEBE ESTAR ACTIVA = 1
// ================================
export const ACTIVE_SALE_EVENT: string = "hotsale" // "hotsale" | "cyber" | "blackfriday" | "navidad" | "padre" | "madre" | "evento" | "none = desactiva campanas"

// DESCUENTOS POR EVENTO Y PRODUCTO
export const SALE_EVENTS: Record<string, Record<number, number>> = {
  hotsale: {
    1: 0.10,
    2: 0.15,
    7: 0.20,
  },
  cyber: {
    1: 0.20,
    4: 0.25,
  },
  blackfriday: {
    2: 0.30,
    5: 0.15,
  },
  navidad: {
    3: 0.10,
    8: 0.20,
  },
  padre: {
    3: 0.10,
    8: 0.20,
  },
  madre: {
    3: 0.10,
    8: 0.20,
  },
  evento: {
    3: 0.10,
    8: 0.20,
  },
}

// FUNCION CENTRAL PARA OBTENER DESCUENTO
export function getProductDiscount(productId: number): number {
  if (ACTIVE_SALE_EVENT === "none") return 0

  return SALE_EVENTS[ACTIVE_SALE_EVENT]?.[productId] || 0
}
