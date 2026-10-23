import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import { isOrderDispatchCutoffReached, type DispatchCutoffOrder } from "./dispatch-cutoff"

type Admin = ReturnType<typeof createAdminClient>

/**
 * Agrega `dispatch_cutoff_reached` (calculado, no es columna) para que la
 * cuenta del cliente muestre u oculte "Cancelar compra" con la misma regla
 * que la base. La cancelación igual se valida en la RPC.
 */
export async function attachDispatchCutoff<T extends DispatchCutoffOrder & { id: number }>(admin: Admin, orders: T[]) {
  if (!orders.length) return orders.map((order) => ({ ...order, dispatch_cutoff_reached: false }))
  const { data, error } = await admin.from("order_packages").select("order_id").in("order_id", orders.map((order) => order.id))
  if (error) throw new Error(error.message)
  const packaged = new Set((data ?? []).map((row) => Number(row.order_id)))
  return orders.map((order) => ({ ...order, dispatch_cutoff_reached: isOrderDispatchCutoffReached(order, packaged.has(order.id)) }))
}
