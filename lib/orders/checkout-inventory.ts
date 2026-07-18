import { STOCK_CHANGED_MESSAGE } from "@/lib/cart/stock-status"
import { createAdminClient } from "@/lib/supabase/admin"

export interface CheckoutInventoryItem {
  productId: number
  quantity: number
  variantId?: number | null
}

type AdminClient = ReturnType<typeof createAdminClient>

function isStockConflict(message?: string) {
  const normalized = message?.toLowerCase() ?? ""

  return (
    normalized.includes("checkout_stock_insufficient") ||
    normalized.includes("stock insuficiente") ||
    normalized.includes("sin stock") ||
    normalized.includes("no está disponible")
  )
}

export async function decrementCheckoutInventory(
  admin: AdminClient,
  items: CheckoutInventoryItem[],
) {
  const { error } = await admin.rpc("decrement_checkout_inventory", {
    p_items: items.map((item) => ({
      product_id: item.productId,
      variant_id: item.variantId ?? null,
      quantity: item.quantity,
    })),
  })

  if (!error) return

  if (isStockConflict(error.message)) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }

  throw new Error(
    error.message || "No se pudo actualizar el inventario de la compra.",
  )
}

export async function deleteIncompleteCheckoutOrder(
  admin: AdminClient,
  orderId: number,
) {
  await admin.from("orden_items").delete().eq("orden_id", orderId)
  await admin.from("ordenes").delete().eq("id", orderId)
}
