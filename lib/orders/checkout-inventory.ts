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

export async function validateCheckoutInventory(
  admin: AdminClient,
  items: CheckoutInventoryItem[],
  reservationSessionId: string | null | undefined,
  orderId: number,
) {
  const { error } = await admin.rpc("validate_checkout_inventory_reservation", {
    p_items: items.map((item) => ({
      product_id: item.productId,
      variant_id: item.variantId ?? null,
      conditioned_stock_id: item.conditionedStockId ?? null,
      quantity: item.quantity,
    })),
    p_session_id: reservationSessionId ?? null,
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
