import { isLocalDeliveryOrder } from "../shipping/local-delivery.ts"

/**
 * Corte de cancelación: el pedido ya salió de BEYONIX. Misma regla que
 * public.order_dispatch_cutoff_reached (20261023100000, provider-aware desde
 * 20261104120000), que es la que decide de verdad en la base; acá sólo se usa
 * para mostrar u ocultar acciones.
 *
 * El QR final del Bulto (andreani_handed_over_at) es el punto de corte. El
 * envío Andreani creado (andreani_envio_id/andreani_tracking) NO alcanza: se
 * genera al terminar el pickeo, antes del Bulto. Sólo un envío histórico
 * creado sin pasar por Despachos (sin armado registrado) cuenta como salido,
 * porque no hay forma de saber si ya se entregó.
 *
 * Regla de proveedor: los campos Andreani (QR final, tracking, estado, envío)
 * y el seguimiento manual sólo son evidencia logística si el proveedor
 * efectivo NO es Envío BEYONIX (isLocalDeliveryOrder: shipping_provider manda;
 * sin él, el fallback legacy envio_proveedor). Un pedido Envío BEYONIX salió
 * sólo por su propio estado (En camino / Entregado).
 */

export const DISPATCH_CUTOFF_ESTADOS = new Set([
  "enviado",
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
  "entregado",
])

const TRANSPORT_STATUS = /(camino|tránsito|transito|distribución|distribucion|reparto|visita|entregado)/

export interface DispatchCutoffOrder {
  estado?: string | null
  andreani_handed_over_at?: string | null
  tracking_number?: string | null
  andreani_estado?: string | null
  andreani_envio_id?: string | null
  andreani_tracking?: string | null
  shipping_provider?: string | null
  envio_proveedor?: string | null
}

const filled = (value: string | null | undefined) => Boolean(value?.trim())

/** `true` si los campos Andreani del pedido son evidencia logística válida (proveedor efectivo distinto de Envío BEYONIX). */
export function hasAndreaniShippingEvidenceScope(order: Pick<DispatchCutoffOrder, "shipping_provider" | "envio_proveedor">) {
  return !isLocalDeliveryOrder(order)
}

/** QR final del Bulto Andreani como evidencia logística: `null` para Envío BEYONIX aunque quede un valor residual. */
export function andreaniHandedOverAt(order: Pick<DispatchCutoffOrder, "andreani_handed_over_at" | "shipping_provider" | "envio_proveedor">) {
  return hasAndreaniShippingEvidenceScope(order) ? order.andreani_handed_over_at ?? null : null
}

/**
 * `hasDispatchPackage`: el pedido tiene armado en Despachos (order_packages).
 * Sin el dato se asume que no (conservador: un envío creado cuenta como salido).
 */
export function isOrderDispatchCutoffReached(order: DispatchCutoffOrder, hasDispatchPackage = false): boolean {
  if (DISPATCH_CUTOFF_ESTADOS.has((order.estado ?? "").toLowerCase())) return true
  if (!hasAndreaniShippingEvidenceScope(order)) return false
  return (
    filled(order.andreani_handed_over_at) ||
    filled(order.tracking_number) ||
    TRANSPORT_STATUS.test((order.andreani_estado ?? "").toLowerCase()) ||
    ((filled(order.andreani_envio_id) || filled(order.andreani_tracking)) && !hasDispatchPackage)
  )
}

/**
 * Entregado: estado propio o delivered_at; el texto de Andreani sólo cuenta
 * cuando el proveedor efectivo no es Envío BEYONIX.
 */
export function isOrderDeliveryReached(order: Pick<DispatchCutoffOrder, "estado" | "andreani_estado" | "shipping_provider" | "envio_proveedor"> & { delivered_at?: string | null }) {
  if ((order.estado ?? "").toLowerCase() === "entregado" || filled(order.delivered_at)) return true
  return hasAndreaniShippingEvidenceScope(order) && (order.andreani_estado ?? "").toLowerCase().includes("entregado")
}
