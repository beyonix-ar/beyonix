"use client"

function storageKey(orderId: number) {
  return `beyonix:guest-order-token:${orderId}`
}

/**
 * Guarda en sessionStorage el token de acceso de un pedido guest recién
 * creado, para que el propio navegador pueda demostrar posesión en
 * requests posteriores (ver /checkout/success y la subida de comprobante).
 * No usamos localStorage ni la URL para evitar que el token persista más
 * de lo necesario o quede expuesto en el historial/referrer.
 */
export function storeGuestOrderToken(orderId: number, token: string | null | undefined) {
  if (typeof window === "undefined" || !token) return

  try {
    window.sessionStorage.setItem(storageKey(orderId), token)
  } catch {
    // sessionStorage puede fallar en modo privado/restringido; el flujo
    // sigue funcionando para pedidos con usuario autenticado.
  }
}

export function getGuestOrderToken(orderId: number): string | null {
  if (typeof window === "undefined") return null

  try {
    return window.sessionStorage.getItem(storageKey(orderId))
  } catch {
    return null
  }
}
