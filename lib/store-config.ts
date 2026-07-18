import { SITE_SETTINGS } from "@/config/site-settings"

// Bonificacion de envio a partir de este subtotal.
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

// Costo de envio base para fallback cuando no hay cotizacion real.
export const SHIPPING_COST = SITE_SETTINGS.shipping.defaultShippingCost
export const SHIPPING_BONUS_MAX = 12000

export interface ShippingBonusSettings {
  defaultShippingCost: number
  freeShippingMinAmount: number
  shippingBonusMax: number
  freeShippingMode: FreeShippingMode
}

export const DEFAULT_SHIPPING_SETTINGS: ShippingBonusSettings = {
  defaultShippingCost: SHIPPING_COST,
  freeShippingMinAmount: FREE_SHIPPING_MIN,
  shippingBonusMax: SHIPPING_BONUS_MAX,
  freeShippingMode: FREE_SHIPPING_MODE,
}

function normalizeShippingSettings(
  settings?: Partial<ShippingBonusSettings> | null,
): ShippingBonusSettings {
  return {
    defaultShippingCost:
      Number.isFinite(settings?.defaultShippingCost) &&
      Number(settings?.defaultShippingCost) >= 0
        ? Number(settings?.defaultShippingCost)
        : DEFAULT_SHIPPING_SETTINGS.defaultShippingCost,
    freeShippingMinAmount:
      Number.isFinite(settings?.freeShippingMinAmount) &&
      Number(settings?.freeShippingMinAmount) >= 0
        ? Number(settings?.freeShippingMinAmount)
        : DEFAULT_SHIPPING_SETTINGS.freeShippingMinAmount,
    shippingBonusMax:
      Number.isFinite(settings?.shippingBonusMax) &&
      Number(settings?.shippingBonusMax) >= 0
        ? Number(settings?.shippingBonusMax)
        : DEFAULT_SHIPPING_SETTINGS.shippingBonusMax,
    freeShippingMode:
      settings?.freeShippingMode === "full" || settings?.freeShippingMode === "off"
        ? settings.freeShippingMode
        : DEFAULT_SHIPPING_SETTINGS.freeShippingMode,
  }
}

export function hasShippingBonus(
  subtotal: number,
  settings?: Partial<ShippingBonusSettings> | null,
) {
  const safeSubtotal = Number.isFinite(subtotal) ? subtotal : 0
  const shippingSettings = normalizeShippingSettings(settings)

  return (
    safeSubtotal >= shippingSettings.freeShippingMinAmount &&
    shippingSettings.freeShippingMode === "full"
  )
}

export function calculateShippingBonus(
  subtotal: number,
  shippingCost: number,
  settings?: Partial<ShippingBonusSettings> | null,
) {
  const safeShippingCost =
    Number.isFinite(shippingCost) && shippingCost > 0 ? shippingCost : 0
  const shippingSettings = normalizeShippingSettings(settings)

  return hasShippingBonus(subtotal, shippingSettings)
    ? Math.min(safeShippingCost, shippingSettings.shippingBonusMax)
    : 0
}

export function calculateCustomerShippingCost(
  subtotal: number,
  shippingCost: number,
  settings?: Partial<ShippingBonusSettings> | null,
) {
  const safeShippingCost =
    Number.isFinite(shippingCost) && shippingCost > 0 ? shippingCost : 0

  return Math.max(
    safeShippingCost - calculateShippingBonus(subtotal, safeShippingCost, settings),
    0,
  )
}

export function getShippingCost(
  subtotal: number,
  settings?: Partial<ShippingBonusSettings> | null,
) {
  const shippingSettings = normalizeShippingSettings(settings)

  return calculateCustomerShippingCost(
    subtotal,
    shippingSettings.defaultShippingCost,
    shippingSettings,
  )
}

export function hasFreeShipping(
  subtotal: number,
  settings?: Partial<ShippingBonusSettings> | null,
) {
  return getShippingCost(subtotal, settings) === 0
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
