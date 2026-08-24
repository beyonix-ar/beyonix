import { SITE_SETTINGS } from "../config/site-settings.ts"

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
export const SHIPPING_BONUS_MAX = 20000

// Subsidio logistico base que BEYONIX absorbe en pedidos que NO alcanzan el
// minimo de compra bonificada (ver calculateCustomerShippingCost). Mismo
// patron que SHIPPING_BONUS_MAX: configurable por env var, con fallback a
// este default, y ademas editable por Admin (ver ShippingBonusSettings).
const configuredLogisticsBaseSubsidy = Number(
  process.env.NEXT_PUBLIC_SHIPPING_LOGISTICS_BASE_SUBSIDY ??
    process.env.SHIPPING_LOGISTICS_BASE_SUBSIDY,
)
export const SHIPPING_LOGISTICS_BASE_SUBSIDY =
  Number.isFinite(configuredLogisticsBaseSubsidy) &&
  configuredLogisticsBaseSubsidy >= 0
    ? configuredLogisticsBaseSubsidy
    : 3000

export interface ShippingBonusSettings {
  defaultShippingCost: number
  freeShippingMinAmount: number
  shippingBonusMax: number
  freeShippingMode: FreeShippingMode
  logisticsBaseSubsidy: number
}

export const DEFAULT_SHIPPING_SETTINGS: ShippingBonusSettings = {
  defaultShippingCost: SHIPPING_COST,
  freeShippingMinAmount: FREE_SHIPPING_MIN,
  shippingBonusMax: SHIPPING_BONUS_MAX,
  freeShippingMode: FREE_SHIPPING_MODE,
  logisticsBaseSubsidy: SHIPPING_LOGISTICS_BASE_SUBSIDY,
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
    logisticsBaseSubsidy:
      Number.isFinite(settings?.logisticsBaseSubsidy) &&
      Number(settings?.logisticsBaseSubsidy) >= 0
        ? Number(settings?.logisticsBaseSubsidy)
        : DEFAULT_SHIPPING_SETTINGS.logisticsBaseSubsidy,
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

// "Terminación comercial": el importe final de envío que paga el cliente
// siempre baja hasta terminar en $900 dentro de su milla (nunca sube). Único
// lugar donde vive esta regla -- reutilizado por calculateCustomerShippingCost
// y por cualquier otro cálculo de precio que en el futuro necesite la misma
// terminación. Ejemplos: 9000 -> 8900, 12000 -> 11900, 9500 -> 8900, 3900 ->
// 3900 (ya terminaba en 900, no cambia).
const COMMERCIAL_ROUNDING_STEP = 1000
const COMMERCIAL_ROUNDING_ENDING = 900

export function roundDownToCommercialEnding(value: number): number {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0
  const rounded =
    Math.floor((safeValue - COMMERCIAL_ROUNDING_ENDING) / COMMERCIAL_ROUNDING_STEP) *
      COMMERCIAL_ROUNDING_STEP +
    COMMERCIAL_ROUNDING_ENDING

  return Math.max(0, rounded)
}

/**
 * Dos políticas de bonificación de envío, mutuamente excluyentes (nunca se
 * suman) para no generar un doble descuento involuntario:
 *
 * 1. Compra que alcanza `freeShippingMinAmount`: política principal, bonifica
 *    hasta `shippingBonusMax` del costo real cotizado.
 * 2. Compra por debajo del mínimo: subsidio logístico chico
 *    (`logisticsBaseSubsidy`, default $3.000) para que el envío no pese tanto
 *    frente a un ticket económico, con el resultado terminado en $900
 *    (`roundDownToCommercialEnding`) para que se sienta un precio comercial y
 *    no una resta contable.
 *
 * `calculateCustomerShippingCost` es la única fuente de verdad de cuánto paga
 * el cliente; `calculateShippingBonus` se deriva de ella (bonus = real -
 * cobrado) en vez de calcularse por su cuenta, así nunca pueden desincronizarse.
 */
export function calculateCustomerShippingCost(
  subtotal: number,
  shippingCost: number,
  settings?: Partial<ShippingBonusSettings> | null,
) {
  const safeShippingCost =
    Number.isFinite(shippingCost) && shippingCost > 0 ? shippingCost : 0
  if (safeShippingCost <= 0) return 0

  const shippingSettings = normalizeShippingSettings(settings)

  if (hasShippingBonus(subtotal, shippingSettings)) {
    const bonus = Math.min(safeShippingCost, shippingSettings.shippingBonusMax)
    return Math.max(safeShippingCost - bonus, 0)
  }

  // Subsidio en $0 (desactivado desde configuración) equivale a no aplicar
  // ninguna transformación: se cobra el costo real tal cual, sin redondear.
  if (shippingSettings.logisticsBaseSubsidy <= 0) return safeShippingCost

  const afterBaseSubsidy = Math.max(
    0,
    safeShippingCost - shippingSettings.logisticsBaseSubsidy,
  )
  return Math.min(safeShippingCost, roundDownToCommercialEnding(afterBaseSubsidy))
}

export function calculateShippingBonus(
  subtotal: number,
  shippingCost: number,
  settings?: Partial<ShippingBonusSettings> | null,
) {
  const safeShippingCost =
    Number.isFinite(shippingCost) && shippingCost > 0 ? shippingCost : 0
  if (safeShippingCost <= 0) return 0

  return Math.max(
    safeShippingCost -
      calculateCustomerShippingCost(subtotal, safeShippingCost, settings),
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
export const ACTIVE_SALE_EVENT: string = "none" // "hotsale" | "cyber" | "blackfriday" | "navidad" | "padre" | "madre" | "evento" | "none = desactiva campanas"

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
