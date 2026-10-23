export const DISPATCH_PATH = "/admin/despachos"

/**
 * El pedido o Bulto abierto en Despachos vive en la URL (?order, ?batch):
 * refrescar, volver o abrir otra pestaña del navegador no lo pierde. Los
 * enlaces viejos con ?tab= siguen abriendo la tabla única.
 */
export type DispatchLocation = { orderId: number | null; batchId: number | null }

function positiveId(value: string | null | undefined) {
  if (!value || !/^\d{1,12}$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function parseDispatchLocation(input: { order?: string | null; batch?: string | null }): DispatchLocation {
  const orderId = positiveId(input.order)
  return { orderId, batchId: orderId ? null : positiveId(input.batch) }
}

export function dispatchLocationFromSearch(search: string): DispatchLocation {
  const params = new URLSearchParams(search)
  return parseDispatchLocation({ order: params.get("order"), batch: params.get("batch") })
}

const CANCELLATION_RETURN = /^\/admin\/pedidos\/\d{1,12}\?tab=cancelacion$/

/** Vuelta al asistente de cancelación del pedido (?return=): sólo esa ruta interna. */
export function parseCancellationReturn(value: string | null | undefined): string | null {
  return value && CANCELLATION_RETURN.test(value) ? value : null
}

/** "Resolver mercadería": abre el retiro del pedido y sabe volver al paso de la cancelación. */
export function cancellationResolveHref(orderId: number) {
  return `${DISPATCH_PATH}?resolve=${orderId}&return=${encodeURIComponent(`/admin/pedidos/${orderId}?tab=cancelacion`)}`
}

export function dispatchLocationHref(location: DispatchLocation) {
  if (location.orderId) return `${DISPATCH_PATH}?order=${location.orderId}`
  if (location.batchId) return `${DISPATCH_PATH}?batch=${location.batchId}`
  return DISPATCH_PATH
}
