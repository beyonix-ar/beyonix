import { STOCK_CHANGED_MESSAGE } from "../cart/stock-status.ts"
import type { createAdminClient } from "../supabase/admin.ts"

export interface CheckoutInventoryItem {
  productId: number
  quantity: number
  variantId?: number | null
  conditionedStockId?: string | null
}

type AdminClient = ReturnType<typeof createAdminClient>

function isStockConflict(message?: string) {
  const normalized = message?.toLowerCase() ?? ""

  return (
    normalized.includes("checkout_stock_insufficient") ||
    normalized.includes("checkout_variant_required") ||
    normalized.includes("stock insuficiente") ||
    normalized.includes("sin stock") ||
    normalized.includes("no está disponible")
  )
}

/**
 * Identidad de la sesión de checkout que puede sostener una reserva. Mismo
 * criterio que `normalizeMercadoPagoCheckoutSessionId`, duplicado acá porque
 * este módulo también lo usa el checkout por transferencia.
 */
export function normalizeReservationSessionId(value: unknown) {
  if (typeof value !== "string") return null

  const sessionId = value.trim()
  return sessionId.length >= 8 && sessionId.length <= 160 ? sessionId : null
}

export class MissingReservationSessionError extends Error {
  constructor() {
    super("La sesión del carrito venció. Actualizá la página.")
    this.name = "MissingReservationSessionError"
  }
}

export class CheckoutReservationExpiredError extends Error {
  constructor() {
    super("Tu reserva venció. Volvé al inicio para comenzar una nueva compra.")
    this.name = "CheckoutReservationExpiredError"
  }
}

export type CheckoutReservationCommitment = "mercadopago" | "transferencia" | "customer_credit"

const RESERVATION_COMMIT_RPC = {
  mercadopago: "commit_mercadopago_checkout_reservation",
  transferencia: "commit_checkout_step_reservation",
  customer_credit: "commit_checkout_step_reservation",
} as const satisfies Record<CheckoutReservationCommitment, string>

/** Mercado Pago commits the existing Step 3 lease without creating a new one. */
export function commitMercadoPagoCheckoutReservation(
  admin: AdminClient,
  items: CheckoutInventoryItem[],
  reservationSessionId: string | null | undefined,
  orderId: number,
): Promise<string> {
  return commitCheckoutStepReservation(admin, items, reservationSessionId, orderId, "mercadopago")
}

/**
 * Ata la reserva vigente del Paso 3 al pedido sin renovarla y devuelve su
 * expires_at original: elegir el medio de pago nunca reinicia los 20 minutos.
 */
export async function commitCheckoutStepReservation(
  admin: AdminClient,
  items: CheckoutInventoryItem[],
  reservationSessionId: string | null | undefined,
  orderId: number,
  commitment: CheckoutReservationCommitment,
): Promise<string> {
  const sessionId = normalizeReservationSessionId(reservationSessionId)
  if (!sessionId) throw new CheckoutReservationExpiredError()
  const { data, error } = await admin.rpc(RESERVATION_COMMIT_RPC[commitment], {
    p_items: items.map((item) => ({
      product_id: item.productId,
      variant_id: item.variantId ?? null,
      conditioned_stock_id: item.conditionedStockId ?? null,
      quantity: item.quantity,
    })),
    p_session_id: sessionId,
    p_order_id: orderId,
  })
  if (error) {
    if (/RESERVATION_EXPIRED|RESERVATION_INVALID|INVALID_SESSION|RESERVATION_LOCKED_TO_ORDER/i.test(error.message)) {
      throw new CheckoutReservationExpiredError()
    }
    if (isStockConflict(error.message)) throw new Error(STOCK_CHANGED_MESSAGE)
    if (/schema cache|PGRST202/i.test(error.message)) {
      throw new Error(
        "El sistema de reservas de stock no está actualizado. Intentá nuevamente luego de aplicar la migración pendiente.",
      )
    }
    throw new Error(error.message || "No se pudo validar la reserva de la compra.")
  }
  if (typeof data !== "string" || !Number.isFinite(Date.parse(data))) {
    throw new Error("La reserva de la compra no devolvió un vencimiento válido.")
  }
  return data
}

export async function deleteIncompleteCheckoutOrder(
  admin: AdminClient,
  orderId: number,
) {
  await admin.from("orden_items").delete().eq("orden_id", orderId)
  await admin.from("ordenes").delete().eq("id", orderId)
}
