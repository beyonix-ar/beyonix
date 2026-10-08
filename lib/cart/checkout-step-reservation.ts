import type { StockReservationItem } from "./stock-reservations"

export const CHECKOUT_STEP_RESERVATION_KEY = "beyonix-checkout-step-3-reservation"

/**
 * Plazo COMERCIAL para pagar, igual para todos los medios: la reserva de stock
 * del Paso 3 (checkout_step_reservation_ttl() en la base). No confundir con la
 * ventana técnica interna de conciliación de transferencias (48 h).
 */
export const CHECKOUT_RESERVATION_MINUTES = 20

/**
 * La reserva de la sesión ya quedó ligada a un pedido (pago iniciado y se
 * volvió atrás, u otra pestaña pagó). No es un vencimiento: se conserva el
 * carrito y el cliente reserva de nuevo.
 */
export const CHECKOUT_RESERVATION_LOCKED_MESSAGE =
  "Esta compra ya tiene un pago iniciado. Si ya pagaste, revisalo en Mis compras. Para comprar de nuevo, volvé a continuar y reservamos los productos otra vez."

export function reservationItemsFromCart(items: ReadonlyArray<{
  product: { id: number }
  quantity: number
  variantId: number | null
  conditionedStockId: string | null
}>): StockReservationItem[] {
  return items.map((item) => ({
    productId: item.product.id,
    quantity: item.quantity,
    variantId: item.variantId,
    conditionedStockId: item.conditionedStockId,
  }))
}

function itemKey(item: StockReservationItem) {
  return `${item.productId}:${item.variantId ?? ""}:${item.conditionedStockId ?? ""}`
}

/**
 * Una línea sin variante de un producto con variantes (venta aleatoria) se
 * reserva como unidades de variantes concretas: se compara por producto,
 * sumando lo reservado de sus variantes (sin el stock condicionado).
 */
export function reservationMatchesCart(
  reserved: readonly StockReservationItem[],
  cart: readonly StockReservationItem[],
) {
  const pooledProducts = new Set(
    cart.filter((item) => item.variantId == null && item.conditionedStockId == null).map((item) => item.productId),
  )
  const quantities = new Map<string, number>()
  for (const item of reserved) {
    const key = pooledProducts.has(item.productId) && item.conditionedStockId == null
      ? `${item.productId}::`
      : itemKey(item)
    quantities.set(key, (quantities.get(key) ?? 0) + item.quantity)
  }
  if (quantities.size !== cart.length) return false
  return cart.every((item) => quantities.get(itemKey(item)) === item.quantity)
}

export function reservationSecondsLeft(
  expiresAt: string,
  serverNow: string,
  receivedAt: number,
  now: number,
) {
  const remaining = Date.parse(expiresAt) - Date.parse(serverNow) - Math.max(0, now - receivedAt)
  return Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / 1000)) : 0
}

export function formatReservationCountdown(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`
}
