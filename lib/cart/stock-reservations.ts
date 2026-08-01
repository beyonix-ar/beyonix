"use server"

import { createClient } from "@/lib/supabase/server"
import { STOCK_CHANGED_MESSAGE } from "@/lib/cart/stock-status"

export interface StockReservationItem {
  productId: number
  quantity: number
  variantId?: number | null
  conditionedStockId?: string | null
}

interface ReserveCartStockPayload {
  sessionId: string
  items: StockReservationItem[]
}

function normalizeReservationItems(items: StockReservationItem[]) {
  return items
    .map((item) => ({
      productId: Number(item.productId),
      quantity: Math.trunc(Number(item.quantity)),
      variantId: item.variantId ? Number(item.variantId) : null,
      conditionedStockId:
        typeof item.conditionedStockId === "string"
          ? item.conditionedStockId
          : null,
    }))
    .filter(
      (item) =>
        Number.isFinite(item.productId) &&
        Number.isFinite(item.quantity) &&
        item.quantity > 0,
    )
}

function isMissingRpcError(error: { code?: string; message?: string }) {
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    error.message?.toLowerCase().includes("reserve_cart_stock")
  )
}

export async function reserveCartStock({
  sessionId,
  items,
}: ReserveCartStockPayload) {
  const normalizedItems = normalizeReservationItems(items)

  if (!sessionId || normalizedItems.length === 0) {
    return {
      success: false,
      configured: true,
      message: STOCK_CHANGED_MESSAGE,
      expiresAt: null,
    }
  }

  const supabase = await createClient()

  const { data, error } = await supabase.rpc("reserve_cart_stock", {
    p_session_id: sessionId,
    p_items: normalizedItems,
  })

  if (error) {
    if (isMissingRpcError(error)) {
      return {
        success: false,
        configured: false,
        message:
          "El sistema de reservas de stock está pendiente de actualización.",
        expiresAt: null,
      }
    }

    return {
      success: false,
      configured: true,
      message: STOCK_CHANGED_MESSAGE,
      expiresAt: null,
    }
  }

  const response =
    data && typeof data === "object"
      ? (data as { expires_at?: string })
      : null

  return {
    success: true,
    configured: true,
    message: null,
    expiresAt: response?.expires_at ?? null,
  }
}
