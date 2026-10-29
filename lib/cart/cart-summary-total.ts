// En el carrito el envío todavía no está cotizado: el importe sólo es el
// total definitivo cuando el envío ya es $0 seguro (cubierto por BEYONIX con
// saldo a favor). "Bonificado" tiene tope, así que puede quedar diferencia.
export const CART_SHIPPING_PENDING_NOTE = "El envío se calcula en el checkout."

export function getCartSummaryTotalPresentation(shippingCoveredByBeyonix: boolean) {
  return shippingCoveredByBeyonix
    ? { label: "Total", note: null }
    : { label: "Subtotal estimado", note: CART_SHIPPING_PENDING_NOTE }
}
