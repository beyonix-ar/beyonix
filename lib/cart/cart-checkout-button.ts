/**
 * "Finalizar compra" del carrito: habilitado = navy; deshabilitado = superficie
 * neutra con texto de alto contraste (globals.css, .beyonix-cart-checkout-btn),
 * en vez de apagar todo el botón con opacidad. Sigue deshabilitado y sin clicks.
 */
export function cartCheckoutButtonState(blocked: boolean) {
  return {
    disabled: blocked,
    className:
      "beyonix-cart-checkout-btn h-10 w-full text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-100",
    style: blocked ? undefined : { backgroundColor: "#112A43" },
  }
}
