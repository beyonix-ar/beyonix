/**
 * Corte de cancelación: el pedido ya salió de BEYONIX. Misma regla que
 * public.order_dispatch_cutoff_reached (20261023100000), que es la que decide
 * de verdad en la base; acá sólo se usa para mostrar u ocultar acciones.
 *
 * El QR final del Bulto (andreani_handed_over_at) es el punto de corte. El
 * envío Andreani creado (andreani_envio_id/andreani_tracking) NO alcanza: se
 * genera al terminar el pickeo, antes del Bulto. Sólo un envío histórico
 * creado sin pasar por Despachos (sin armado registrado) cuenta como salido,
 * porque no hay forma de saber si ya se entregó.
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
}

const filled = (value: string | null | undefined) => Boolean(value?.trim())

/**
 * `hasDispatchPackage`: el pedido tiene armado en Despachos (order_packages).
 * Sin el dato se asume que no (conservador: un envío creado cuenta como salido).
 */
export function isOrderDispatchCutoffReached(order: DispatchCutoffOrder, hasDispatchPackage = false): boolean {
  return (
    filled(order.andreani_handed_over_at) ||
    DISPATCH_CUTOFF_ESTADOS.has((order.estado ?? "").toLowerCase()) ||
    filled(order.tracking_number) ||
    TRANSPORT_STATUS.test((order.andreani_estado ?? "").toLowerCase()) ||
    ((filled(order.andreani_envio_id) || filled(order.andreani_tracking)) && !hasDispatchPackage)
  )
}
