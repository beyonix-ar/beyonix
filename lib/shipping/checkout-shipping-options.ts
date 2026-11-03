import { LOCAL_DELIVERY_PROVIDER } from "./local-delivery.ts"

/**
 * Identidad de una opción de envío del checkout: proveedor + modalidad.
 * "domicilio" sola no alcanza para distinguir Envío BEYONIX de Andreani a
 * domicilio (ambas son entregas en el domicilio del cliente).
 */
export type CheckoutShippingProvider = "andreani" | typeof LOCAL_DELIVERY_PROVIDER
export type CheckoutShippingModality = "domicilio" | "sucursal"
export type CheckoutShippingOptionKey = `${CheckoutShippingProvider}:${CheckoutShippingModality}`

export const LOCAL_DELIVERY_OPTION_KEY: CheckoutShippingOptionKey = `${LOCAL_DELIVERY_PROVIDER}:domicilio`

export function getCheckoutShippingOptionKey(
  provider: CheckoutShippingProvider,
  type: CheckoutShippingModality,
): CheckoutShippingOptionKey {
  return `${provider}:${type}`
}

/** Orden fijo: Envío BEYONIX → Andreani domicilio → Andreani sucursal. */
const OPTION_ORDER: CheckoutShippingOptionKey[] = [
  LOCAL_DELIVERY_OPTION_KEY,
  "andreani:domicilio",
  "andreani:sucursal",
]

export function sortCheckoutShippingOptions<T extends { key: CheckoutShippingOptionKey }>(options: readonly T[]): T[] {
  return [...options].sort((left, right) => OPTION_ORDER.indexOf(left.key) - OPTION_ORDER.indexOf(right.key))
}

/**
 * Elección a conservar después de recalcular las opciones:
 * - si la elegida sigue existiendo, se conserva;
 * - si era Envío BEYONIX y dejó de ofrecerse (CP no habilitado, modalidad
 *   desactivada), se conserva como elección PENDIENTE: no coincide con
 *   ninguna opción visible (ver isCheckoutShippingSelectionLost), así que no
 *   hay envío seleccionado y el cliente tiene que volver a elegir; nunca se
 *   reemplaza en silencio por otra modalidad con otro precio;
 * - en cualquier otro caso (sin elección, o una opción Andreani que ya no
 *   está) se sugiere la primera del orden fijo.
 */
export function resolveCheckoutShippingSelection(
  current: CheckoutShippingOptionKey | null,
  options: readonly { key: CheckoutShippingOptionKey }[],
): CheckoutShippingOptionKey | null {
  if (current && options.some((option) => option.key === current)) return current
  if (current === LOCAL_DELIVERY_OPTION_KEY) return current
  return sortCheckoutShippingOptions(options)[0]?.key ?? null
}

/**
 * Al reiniciar las opciones (destino incompleto, carrito vacío) se descarta
 * una elección de Andreani, pero una de Envío BEYONIX queda pendiente por la
 * misma regla que resolveCheckoutShippingSelection.
 */
export function keepPendingLocalDeliverySelection(current: CheckoutShippingOptionKey | null) {
  return current === LOCAL_DELIVERY_OPTION_KEY ? current : null
}

/** La elección es Envío BEYONIX pero la modalidad ya no se ofrece: no hay envío seleccionado. */
export function isCheckoutShippingSelectionLost(
  current: CheckoutShippingOptionKey | null,
  options: readonly { key: CheckoutShippingOptionKey }[],
) {
  return current === LOCAL_DELIVERY_OPTION_KEY && !options.some((option) => option.key === current)
}
