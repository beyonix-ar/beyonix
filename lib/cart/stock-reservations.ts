"use server"

import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
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
  | { success: true; expiresAt: string; reservationStartedAt: string; reserved: boolean; serverNow: string }
  | { success: false; code: StockReservationErrorCode; conflicts?: StockReservationItem[] }

export type CartStockReservationSnapshot =
  | { status: "active"; expiresAt: string; serverNow: string; items: StockReservationItem[] }
  | { status: "missing" | "expired" | "locked" | "invalid" | "error" }

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

async function getStockConflicts(sessionId: string, items: StockReservationItem[]) {
  const admin = createAdminClient()
  const grouped = new Map<string, StockReservationItem>()
  for (const item of items) {
    const key = `${item.productId}:${item.variantId ?? ""}:${item.conditionedStockId ?? ""}`
    const existing = grouped.get(key)
    grouped.set(key, { ...item, quantity: item.quantity + (existing?.quantity ?? 0) })
  }
  const results = await Promise.all([...grouped.values()].map(async (item) => {
    const { data, error } = await admin.rpc("available_stock_for_session", {
      p_product_id: item.productId,
      p_variant_id: item.variantId ?? null,
      p_conditioned_stock_id: item.conditionedStockId ?? null,
      p_session_id: sessionId,
    })
    return !error && typeof data === "number" && data < item.quantity ? item : null
  }))
  return results.filter((item): item is StockReservationItem => item !== null)
}

/** Recupera la reserva existente. Esta lectura nunca crea ni renueva una reserva. */
export async function getCartStockReservation(sessionId: string): Promise<CartStockReservationSnapshot> {
  const normalizedSessionId = normalizeReservationSessionId(sessionId)
  if (!normalizedSessionId) return { status: "invalid" }

  const client = await createClient()
  const admin = createAdminClient()
  const { data: session, error } = await admin.from("checkout_reservation_sessions")
    .select("user_id, expires_at, order_id")
    .eq("session_id", normalizedSessionId)
    .maybeSingle()
  if (error) return { status: "error" }
  if (!session) return { status: "missing" }

  if (session.user_id) {
    const { data: auth } = await client.auth.getUser()
    if (auth.user?.id !== session.user_id) return { status: "invalid" }
  }
  if (session.order_id !== null) return { status: "locked" }
  const serverNow = new Date().toISOString()
  if (Date.parse(session.expires_at) <= Date.parse(serverNow)) return { status: "expired" }

  const { data: rows, error: rowsError } = await admin.from("stock_reservations")
    .select("product_id, variant_id, conditioned_stock_id, quantity")
    .eq("session_id", normalizedSessionId)
    .is("order_id", null)
    .gt("expires_at", serverNow)
  if (rowsError) return { status: "error" }
  if (!rows?.length) return { status: "missing" }

  return {
    status: "active",
    expiresAt: session.expires_at,
    serverNow,
    items: rows.map((row) => ({
      productId: row.product_id,
      variantId: row.variant_id,
      conditionedStockId: row.conditioned_stock_id,
      quantity: row.quantity,
    })),
  }
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
  if (error) {
    const code = reservationErrorCode(error.message)
    return {
      success: false,
      code,
      ...(code === "OUT_OF_STOCK"
        ? { conflicts: await getStockConflicts(normalizedSessionId, items) }
        : {}),
    }
  }

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
    serverNow: new Date().toISOString(),
  }
}
