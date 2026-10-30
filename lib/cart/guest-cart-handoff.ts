/**
 * Traspaso del carrito de invitado a la cuenta al iniciar sesión / crear
 * cuenta. Antes, `SIGNED_IN` REEMPLAZABA el carrito del invitado
 * (sessionStorage) por el guardado de la cuenta (localStorage), o por uno
 * vacío: quien armaba el carrito sin sesión y tocaba "Finalizar compra" lo
 * perdía al loguearse.
 *
 * Regla: sólo un invitado CONFIRMADO (la sesión inicial ya se resolvió sin
 * usuario) traspasa su carrito. Se une con el de la cuenta con la regla
 * existente de `normalizeCart` (misma línea producto+variante -> se suman
 * cantidades hasta el stock del snapshot; el resto se conserva), con las líneas del
 * invitado primero. Una sesión ya existente al cargar la página nunca
 * traspasa nada: su sessionStorage ya es el carrito de esa cuenta y sumarlo
 * duplicaría cantidades.
 *
 * Si la sesión se rechaza enseguida (p. ej. cuenta sin activar: setSession +
 * signOut dentro del mismo login), `resolveCartOnSignOut` devuelve el carrito
 * del invitado tal como estaba y el de la cuenta como estaba antes.
 */

import { normalizeCart, type CartItem } from "./cart-items.ts"
import { getProductStock } from "./stock-status.ts"

export type CartAuthOwner =
  | { kind: "unknown" }
  | { kind: "guest" }
  | { kind: "user"; userId: string }

export interface GuestCartHandoff {
  userId: string
  guestCart: CartItem[]
  accountCart: CartItem[]
}

function mergeGuestAndAccountCart(guestCart: CartItem[], accountCart: CartItem[]) {
  const merged = normalizeCart([...guestCart, ...accountCart])
  for (const line of merged) {
    const guestLine = guestCart.find((item) => item.product.id === line.product.id && item.color === line.color)
    const accountLine = accountCart.find((item) => item.product.id === line.product.id && item.color === line.color)
    if (!guestLine || !accountLine) continue

    const available = Math.min(
      getProductStock(guestLine.product, line.color),
      getProductStock(accountLine.product, line.color),
    )
    // Si no queda stock, se conserva la línea para que la reconciliación
    // habitual la marque y el cliente pueda corregirla sin pérdida silenciosa.
    if (available > 0) line.quantity = Math.min(line.quantity, available)
  }
  return merged
}

export function resolveCartOnSignIn({
  owner,
  userId,
  currentCart,
  storedAccountCart,
}: {
  owner: CartAuthOwner
  userId: string
  currentCart: CartItem[]
  storedAccountCart: CartItem[]
}): { cart: CartItem[]; handoff: GuestCartHandoff | null } {
  if (owner.kind !== "guest" || currentCart.length === 0) {
    return { cart: storedAccountCart, handoff: null }
  }

  return {
    cart: mergeGuestAndAccountCart(currentCart, storedAccountCart),
    handoff: { userId, guestCart: currentCart, accountCart: storedAccountCart },
  }
}

export function resolveCartOnSignOut(handoff: GuestCartHandoff | null): {
  cart: CartItem[]
  restoreAccount: { userId: string; cart: CartItem[] } | null
} {
  if (!handoff) return { cart: [], restoreAccount: null }

  return {
    cart: handoff.guestCart,
    restoreAccount: { userId: handoff.userId, cart: handoff.accountCart },
  }
}
