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
    normalized.includes("no está disponible") ||
    // El session_id de esta sesión ya está atado a otro usuario autenticado
    // (ver validate_checkout_inventory_reservation). En la práctica exige
    // adivinar un UUID ajeno -- pero de ocurrir, nunca se muestra el motivo
    // técnico real al cliente, sólo el mismo mensaje genérico de siempre.
    normalized.includes("reservation_session_mismatch")
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

/**
 * Cierra la orden contra el inventario: revalida catálogo y disponibilidad
 * REAL (stock derivado menos reservas activas de otras sesiones) y deja la
 * reserva de esta sesión atada a la orden, todo en una sola transacción de
 * Postgres bajo advisory lock por producto.
 *
 * `reservationSessionId` es obligatorio: sin sesión no hay reserva posible y
 * dos clientes podrían llegar a pagar la misma última unidad. Antes se
 * mandaba `p_session_id: null` a propósito y esa era exactamente la causa de
 * la sobreventa; ya no existe un camino que valide sin reservar.
 */
export async function validateCheckoutInventory(
  admin: AdminClient,
  items: CheckoutInventoryItem[],
  reservationSessionId: string | null | undefined,
  orderId: number,
) {
  const sessionId = normalizeReservationSessionId(reservationSessionId)

  if (!sessionId) {
    throw new MissingReservationSessionError()
  }

  const { error } = await admin.rpc("validate_checkout_inventory_reservation", {
    p_items: items.map((item) => ({
      product_id: item.productId,
      variant_id: item.variantId ?? null,
      conditioned_stock_id: item.conditionedStockId ?? null,
      quantity: item.quantity,
    })),
    p_session_id: sessionId,
    p_order_id: orderId,
  })

  if (!error) return

  if (isStockConflict(error.message)) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }

  if (
    /validate_checkout_inventory_reservation|schema cache|PGRST202/i.test(
      error.message,
    )
  ) {
    throw new Error(
      "El sistema de reservas de stock no está actualizado. Intentá nuevamente luego de aplicar la migración pendiente.",
    )
  }

  throw new Error(
    error.message || "No se pudo validar el inventario de la compra.",
  )
}

export async function deleteIncompleteCheckoutOrder(
  admin: AdminClient,
  orderId: number,
) {
  await admin.from("orden_items").delete().eq("orden_id", orderId)
  await admin.from("ordenes").delete().eq("id", orderId)
}
