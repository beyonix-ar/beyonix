import { STOCK_CHANGED_MESSAGE } from "../cart/stock-status.ts"
import { CHECKOUT_RESERVATION_LOCKED_MESSAGE } from "../cart/checkout-step-reservation.ts"
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

/**
 * La reserva de esta sesión ya está ligada a OTRO pedido (p. ej. se inició
 * Mercado Pago y se volvió atrás para pagar con otro medio). No venció: el
 * cliente tiene que reservar de nuevo con una sesión nueva. Extiende
 * CheckoutReservationExpiredError para que ningún camino existente la trate
 * como reserva válida.
 */
export class CheckoutReservationLockedError extends CheckoutReservationExpiredError {
  constructor() {
    super()
    this.message = CHECKOUT_RESERVATION_LOCKED_MESSAGE
    this.name = "CheckoutReservationLockedError"
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
    if (/RESERVATION_LOCKED_TO_ORDER/i.test(error.message)) {
      throw new CheckoutReservationLockedError()
    }
    if (/RESERVATION_EXPIRED|RESERVATION_INVALID|INVALID_SESSION/i.test(error.message)) {
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

/** Mismo estado terminal que ya usan los intentos de checkout dados de baja. */
export const INCOMPLETE_CHECKOUT_PAYMENT_STATUS = "checkout_superseded"

export type IncompleteCheckoutOrderCleanup = "deleted" | "cancelled" | "not_pending" | "failed"

/**
 * Retira un pedido de checkout que no llegó a completarse. Sólo actúa sobre
 * pedidos todavía `pendiente` (nunca toca uno pagado por una carrera). Si el
 * DELETE no se puede hacer (p. ej. ya hay movimientos de saldo o auditoría que
 * lo referencian), lo cancela: nunca puede quedar vivo, pagable ni bloqueando
 * la misma compra (`customer_checkout_fingerprint`). Cancelar/borrar libera su
 * reserva (release_order_stock_reservation / on delete cascade).
 */
export async function deleteIncompleteCheckoutOrder(
  admin: AdminClient,
  orderId: number,
): Promise<IncompleteCheckoutOrderCleanup> {
  const { data: pending, error: readError } = await admin
    .from("ordenes")
    .select("id")
    .eq("id", orderId)
    .eq("estado", "pendiente")
    .maybeSingle()
  if (!readError && !pending) return "not_pending"

  if (!readError) {
    const items = await admin.from("orden_items").delete().eq("orden_id", orderId)
    if (!items.error) {
      const { data: deleted, error } = await admin
        .from("ordenes")
        .delete()
        .eq("id", orderId)
        .eq("estado", "pendiente")
        .select("id")
        .maybeSingle()
      if (!error && deleted) return "deleted"
    }
  }

  const { data: cancelled, error: cancelError } = await admin
    .from("ordenes")
    .update({
      estado: "cancelado",
      payment_status: INCOMPLETE_CHECKOUT_PAYMENT_STATUS,
      financial_status: "cancelled",
      cancelled_at: new Date().toISOString(),
    } as never)
    .eq("id", orderId)
    .eq("estado", "pendiente")
    .select("id")
    .maybeSingle()
  if (!cancelError && cancelled) return "cancelled"

  console.error("INCOMPLETE_CHECKOUT_ORDER_CLEANUP_FAILED", {
    orderId,
    readError: readError?.message,
    cancelError: cancelError?.message,
  })
  return cancelError ? "failed" : "not_pending"
}
