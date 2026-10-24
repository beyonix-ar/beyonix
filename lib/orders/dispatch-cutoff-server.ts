import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import { isOrderDispatchCutoffReached, type DispatchCutoffOrder } from "./dispatch-cutoff"
import { getDispatchProgress } from "./shipping-stage"

type Admin = ReturnType<typeof createAdminClient>

/**
 * Agrega `dispatch_cutoff_reached` (calculado, no es columna) para que la
 * cuenta del cliente muestre u oculte "Cancelar compra" con la misma regla
 * que la base. La cancelación igual se valida en la RPC.
 *
 * También agrega `dispatch_progress` (pickeo / listo / QR final) para la
 * etapa visible del envío, sin exponer el armado ni el QR al cliente.
 */
export async function attachDispatchCutoff<T extends DispatchCutoffOrder & { id: number }>(admin: Admin, orders: T[]) {
  if (!orders.length) return orders.map((order) => ({ ...order, dispatch_cutoff_reached: false, dispatch_progress: getDispatchProgress(order.andreani_handed_over_at, null) }))
  const { data, error } = await admin.from("order_packages").select("order_id,status").in("order_id", orders.map((order) => order.id))
  if (error) throw new Error(error.message)
  const packages = new Map((data ?? []).map((row) => [Number(row.order_id), String(row.status)]))
  return orders.map((order) => ({
    ...order,
    dispatch_cutoff_reached: isOrderDispatchCutoffReached(order, packages.has(order.id)),
    dispatch_progress: getDispatchProgress(order.andreani_handed_over_at, packages.get(order.id)),
  }))
}
