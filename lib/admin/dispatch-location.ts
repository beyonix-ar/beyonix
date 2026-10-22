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

export function dispatchLocationHref(location: DispatchLocation) {
  if (location.orderId) return `${DISPATCH_PATH}?order=${location.orderId}`
  if (location.batchId) return `${DISPATCH_PATH}?batch=${location.batchId}`
  return DISPATCH_PATH
}
