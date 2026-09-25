"use server"

import { createClient } from "@/lib/supabase/server"
import { normalizeReservationSessionId } from "@/lib/orders/checkout-inventory"

export interface StockReservationItem {
  productId: number
  quantity: number
  variantId?: number | null
  conditionedStockId?: string | null
}

export type StockReservationErrorCode =
  | "OUT_OF_STOCK"
  | "INVALID_QUANTITY"
  | "INVALID_VARIANT"
  | "RESERVATION_EXPIRED"
  | "RESERVATION_LOCKED_TO_ORDER"
  | "INVALID_SESSION"
  | "INTERNAL_ERROR"

export type StockReservationResult =
  | { success: true; expiresAt: string; reservationStartedAt: string; reserved: boolean }
  | { success: false; code: StockReservationErrorCode }

const ERROR_CODES: readonly StockReservationErrorCode[] = [
  "OUT_OF_STOCK",
  "INVALID_QUANTITY",
  "INVALID_VARIANT",
  "RESERVATION_EXPIRED",
  "RESERVATION_LOCKED_TO_ORDER",
  "INVALID_SESSION",
]

function reservationErrorCode(message?: string): StockReservationErrorCode {
  return ERROR_CODES.find((candidate) =>
    new RegExp(`\\b${candidate}\\b`).test(message ?? ""),
  ) ?? "INTERNAL_ERROR"
}

/** Backend preparado para Paso 3. [] libera ítems sin reiniciar el reloj. */
export async function reserveCartStock({
  sessionId,
  items,
}: {
  sessionId: string
  items: StockReservationItem[]
}): Promise<StockReservationResult> {
  const normalizedSessionId = normalizeReservationSessionId(sessionId)
  if (!normalizedSessionId) return { success: false, code: "INVALID_SESSION" }
  if (!Array.isArray(items) || items.length > 50 || items.some((item) =>
    !item || typeof item !== "object" ||
    !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 3,
  )) return { success: false, code: "INVALID_QUANTITY" }
  if (items.some((item) =>
    !Number.isSafeInteger(item.productId) || item.productId <= 0 ||
    (item.variantId != null && (!Number.isSafeInteger(item.variantId) || item.variantId <= 0)),
  )) return { success: false, code: "INVALID_VARIANT" }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("reserve_cart_stock", {
    p_session_id: normalizedSessionId,
    p_items: items,
  })
  if (error) return { success: false, code: reservationErrorCode(error.message) }

  const response = data as {
    reserved?: boolean
    expires_at?: string
    reservation_started_at?: string
  } | null
  if (!response?.expires_at || !response.reservation_started_at) {
    return { success: false, code: "INTERNAL_ERROR" }
  }
  return {
    success: true,
    reserved: response.reserved === true,
    expiresAt: response.expires_at,
    reservationStartedAt: response.reservation_started_at,
  }
}
