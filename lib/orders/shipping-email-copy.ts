import { isLocalDeliveryOrder } from "../shipping/local-delivery.ts"

type OrderShippingProvider = { shipping_provider?: string | null; envio_proveedor?: string | null }

/**
 * Próximo paso que se le anuncia al cliente cuando su pago queda confirmado.
 * Envío BEYONIX no tiene número ni link de seguimiento (lo entrega BEYONIX):
 * se avisa cuando sale en camino.
 */
export function getOrderPreparationFollowUp(order: OrderShippingProvider) {
  return isLocalDeliveryOrder(order)
    ? "Tu pedido está siendo preparado. Te vamos a avisar cuando esté en camino."
    : "Cuando sea despachado te vamos a enviar el número o link de seguimiento."
}
