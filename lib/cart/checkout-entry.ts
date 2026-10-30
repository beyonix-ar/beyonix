import { buildLoginHref } from "../auth/safe-redirect.ts"

export const CHECKOUT_PATH = "/checkout"

/**
 * Destino de "Finalizar compra": con sesión, el checkout; sin sesión (o
 * mientras todavía se verifica), primero /login con regreso al checkout. Si
 * la sesión ya existía, /login redirige solo al checkout. El carrito de
 * invitado se conserva al autenticarse (ver `lib/cart/guest-cart-handoff.ts`).
 */
export function getCheckoutEntryHref(isAuthenticated: boolean) {
  return isAuthenticated ? CHECKOUT_PATH : buildLoginHref(CHECKOUT_PATH)
}
