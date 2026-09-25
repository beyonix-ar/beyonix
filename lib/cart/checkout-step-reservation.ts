import type { StockReservationItem } from "./stock-reservations"

export const CHECKOUT_STEP_RESERVATION_KEY = "beyonix-checkout-step-3-reservation"

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

export function reservationMatchesCart(
  reserved: readonly StockReservationItem[],
  cart: readonly StockReservationItem[],
) {
  if (reserved.length !== cart.length) return false
  const quantities = new Map(reserved.map((item) => [itemKey(item), item.quantity]))
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
