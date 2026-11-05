/**
 * Envío BEYONIX: entrega local propia, elegible por código postal.
 *
 * Reglas puras (sin base ni red) compartidas por el checkout, el servidor y
 * Admin, para que el importe que ve el cliente y el que valida el pedido
 * salgan siempre del mismo cálculo:
 *
 * - Elegibilidad: SÓLO el código postal configurado (nunca el nombre de la
 *   ciudad).
 * - Importe al cliente: `customerPrice` si el subtotal de productos (después
 *   de descuentos de producto, antes de transferencia, cupones y saldo a
 *   favor) no llega a `freeThreshold`; $0 desde el umbral.
 * - Costo interno: `internalDeliveryCost` por pedido entregado, cobre o no
 *   el cliente. Es dato interno: nunca viaja en la configuración pública.
 *
 * Es independiente de la bonificación de envío de Andreani
 * (`ShippingBonusSettings`): ninguna de las dos configuraciones afecta a la
 * otra.
 */

export const LOCAL_DELIVERY_PROVIDER = "beyonix"
export const LOCAL_DELIVERY_NAME = "Envío BEYONIX"
export const LOCAL_DELIVERY_SUBTITLE = "Entrega local en tu zona"
/** Clave de `site_settings`. */
export const LOCAL_DELIVERY_SETTINGS_KEY = "local_delivery"
export const LOCAL_DELIVERY_MAX_POSTAL_CODES = 200
const MAX_AMOUNT = 10_000_000

export interface LocalDeliverySettings {
  enabled: boolean
  /** Importe que paga el cliente por debajo del umbral. */
  customerPrice: number
  /** Costo interno previsto de cada entrega (lo que cobra el cadete). */
  internalDeliveryCost: number
  /** Subtotal de productos desde el que el envío es gratis para el cliente. */
  freeThreshold: number
  /** Códigos postales habilitados, normalizados y sin duplicados. */
  postalCodes: string[]
}

/** Lo que puede ver el navegador: sin el costo interno. */
export type PublicLocalDeliverySettings = Omit<LocalDeliverySettings, "internalDeliveryCost">

/**
 * Configuración inicial de la modalidad mientras Admin no guardó otra: sólo
 * aplica si la clave nunca se escribió (una lectura fallida del servidor
 * corta la operación, ver getLocalDeliverySettings).
 */
export const DEFAULT_LOCAL_DELIVERY_SETTINGS: LocalDeliverySettings = {
  enabled: true,
  customerPrice: 2_500,
  internalDeliveryCost: 2_500,
  freeThreshold: 50_000,
  postalCodes: ["2000"],
}

export class LocalDeliverySettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LocalDeliverySettingsError"
  }
}

/** CP argentino de 4 dígitos ("S2000" o " 2000 " → "2000"); `null` si no es válido. */
export function normalizeLocalDeliveryPostalCode(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null
  const raw = String(value).trim().toUpperCase().replace(/\s+/g, "")
  const match = /^(?:[A-Z])?(\d{4})(?:[A-Z]{3})?$/.exec(raw)
  return match ? match[1] : null
}

function wholeAmount(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number.NaN
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_AMOUNT) return null
  return Math.round(numeric)
}

function uniquePostalCodes(values: readonly string[]) {
  return [...new Set(values)].sort()
}

/**
 * Configuración guardada pero inválida o incompleta: la modalidad queda
 * DESACTIVADA (fail closed). Nunca se completan campos con valores activos.
 * Conserva los importes iniciales sólo como referencia visible en Admin.
 */
export const INVALID_LOCAL_DELIVERY_SETTINGS: LocalDeliverySettings = {
  ...DEFAULT_LOCAL_DELIVERY_SETTINGS,
  enabled: false,
  postalCodes: [],
}

/**
 * Valor leído de `site_settings`:
 * - clave AUSENTE (`present=false`, nunca guardada): configuración inicial;
 * - presente y válida: exactamente lo guardado (mismas reglas que Admin);
 * - presente pero inválida, incompleta o corrupta: desactivada.
 */
export function normalizeStoredLocalDeliverySettings(value: unknown, present: boolean): LocalDeliverySettings {
  if (!present) return DEFAULT_LOCAL_DELIVERY_SETTINGS
  try {
    return parseLocalDeliverySettingsPatch(value)
  } catch {
    // Sin el valor guardado en el log: sólo la señal para revisar Admin.
    console.warn("LOCAL_DELIVERY_SETTINGS_INVALID", { action: "disabled" })
    return INVALID_LOCAL_DELIVERY_SETTINGS
  }
}

/** Valor enviado por Admin (estricto): cualquier dato inválido se rechaza con un mensaje claro. */
export function parseLocalDeliverySettingsPatch(value: unknown): LocalDeliverySettings {
  const fields = ["enabled", "customerPrice", "internalDeliveryCost", "freeThreshold", "postalCodes"]
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(value, key))) {
    throw new LocalDeliverySettingsError("La configuración de Envío BEYONIX no es válida.")
  }
  const source = value as Record<string, unknown>
  if (typeof source.enabled !== "boolean") {
    throw new LocalDeliverySettingsError("Indicá si Envío BEYONIX está activado.")
  }
  const customerPrice = wholeAmount(source.customerPrice)
  const internalDeliveryCost = wholeAmount(source.internalDeliveryCost)
  const freeThreshold = wholeAmount(source.freeThreshold)
  if (customerPrice === null) throw new LocalDeliverySettingsError("El precio al cliente debe ser un importe mayor o igual a $0.")
  if (internalDeliveryCost === null) throw new LocalDeliverySettingsError("El costo interno debe ser un importe mayor o igual a $0.")
  if (freeThreshold === null || freeThreshold <= 0) {
    throw new LocalDeliverySettingsError("El monto de envío gratis debe ser mayor a $0.")
  }
  if (!Array.isArray(source.postalCodes) || source.postalCodes.length > LOCAL_DELIVERY_MAX_POSTAL_CODES) {
    throw new LocalDeliverySettingsError("La lista de códigos postales no es válida.")
  }
  const postalCodes: string[] = []
  for (const raw of source.postalCodes) {
    const code = normalizeLocalDeliveryPostalCode(raw)
    if (!code) throw new LocalDeliverySettingsError("Cada código postal debe tener 4 números.")
    if (postalCodes.includes(code)) throw new LocalDeliverySettingsError(`El código postal ${code} está repetido.`)
    postalCodes.push(code)
  }
  if (source.enabled && postalCodes.length === 0) {
    throw new LocalDeliverySettingsError("Agregá al menos un código postal para activar Envío BEYONIX.")
  }
  return { enabled: source.enabled, customerPrice, internalDeliveryCost, freeThreshold, postalCodes: uniquePostalCodes(postalCodes) }
}

export function toPublicLocalDeliverySettings(settings: LocalDeliverySettings): PublicLocalDeliverySettings {
  return {
    enabled: settings.enabled,
    customerPrice: settings.customerPrice,
    freeThreshold: settings.freeThreshold,
    postalCodes: [...settings.postalCodes],
  }
}

export function isLocalDeliveryPostalCodeEligible(
  settings: Pick<PublicLocalDeliverySettings, "enabled" | "postalCodes">,
  postalCode: unknown,
) {
  const code = normalizeLocalDeliveryPostalCode(postalCode)
  return settings.enabled && code !== null && settings.postalCodes.includes(code)
}

/**
 * Importe del envío para el cliente. Recibe sólo el subtotal de productos:
 * transferencia, cupones y saldo a favor son formas de pago o descuentos
 * posteriores y no cambian ni la elegibilidad ni el precio del envío.
 */
export function getLocalDeliveryCustomerCost(
  settings: Pick<PublicLocalDeliverySettings, "customerPrice" | "freeThreshold">,
  productsTotal: number,
) {
  const subtotal = Number.isFinite(productsTotal) ? productsTotal : 0
  return subtotal >= settings.freeThreshold ? 0 : settings.customerPrice
}

export interface LocalDeliveryQuote {
  costCharged: number
  freeShipping: boolean
}

/** `null` cuando la modalidad no se ofrece para ese CP (desactivada o no habilitado). */
export function quoteLocalDelivery(
  settings: PublicLocalDeliverySettings,
  postalCode: unknown,
  productsTotal: number,
): LocalDeliveryQuote | null {
  if (!isLocalDeliveryPostalCodeEligible(settings, postalCode)) return null
  const costCharged = getLocalDeliveryCustomerCost(settings, productsTotal)
  return { costCharged, freeShipping: costCharged === 0 }
}

export function isLocalDeliveryProvider(provider: string | null | undefined) {
  return (provider ?? "").trim().toLowerCase() === LOCAL_DELIVERY_PROVIDER
}

/**
 * Proveedor logístico persistido de un pedido (columna nueva o legado). Un
 * shipping_provider NULL, vacío o sólo con espacios cuenta como ausente: mismo
 * criterio que public.order_is_local_delivery (migración 20261104120000).
 */
export function isLocalDeliveryOrder(order: { shipping_provider?: string | null; envio_proveedor?: string | null }) {
  return isLocalDeliveryProvider(order.shipping_provider?.trim() || order.envio_proveedor)
}
