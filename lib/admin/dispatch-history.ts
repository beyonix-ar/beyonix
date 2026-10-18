import type { DispatchAdmin } from "./dispatch"

export type DispatchHistory = {
  batch: { id: number; code: string; display_number: number | null; created_at: string; closed_at: string | null; handed_over_at: string | null; status: string }
  orderCount: number
  parcelCount: number
  preparedBy: string[]
  assembledBy: string | null
  controlledBy: string[]
  deliveredBy: string | null
  items: Array<{ orderId: number; parcelCount: number; removedAt: string | null; removalReason: string | null; cancelled: boolean; preparedBy: string | null; controlledBy: string | null; removedBy: string | null }>
}

export async function getDispatchHistory(admin: DispatchAdmin, batchId: number): Promise<DispatchHistory | null> {
  const [batchResult, itemsResult] = await Promise.all([
    admin.from("dispatch_batches").select("id,code,display_number,status,created_at,closed_at,handed_over_at,created_by,closed_by,handed_over_by").eq("id", batchId).maybeSingle(),
    admin.from("dispatch_batch_items").select("order_id,package_id,removed_at,removal_reason,removed_by,verified_by").eq("batch_id", batchId).order("order_id"),
  ])
  if (batchResult.error || itemsResult.error) throw batchResult.error ?? itemsResult.error
  if (!batchResult.data) return null
  const batch = batchResult.data
  const memberships = itemsResult.data ?? []
  const packageIds = memberships.map((item) => item.package_id)
  const [packagesResult, ordersResult] = await Promise.all([
    packageIds.length ? admin.from("order_packages").select("id,parcel_count,prepared_by").in("id", packageIds) : Promise.resolve({ data: [], error: null }),
    memberships.length ? admin.from("ordenes").select("id,cancelled_at").in("id", memberships.map((item) => item.order_id)) : Promise.resolve({ data: [], error: null }),
  ])
  if (packagesResult.error || ordersResult.error) throw packagesResult.error ?? ordersResult.error
  const packages = new Map((packagesResult.data ?? []).map((item) => [item.id, item]))
  const cancelled = new Set((ordersResult.data ?? []).filter((item) => item.cancelled_at).map((item) => item.id))
  const actorIds = [...new Set([batch.created_by, batch.closed_by, batch.handed_over_by,
    ...memberships.flatMap((item) => [item.verified_by, item.removed_by, packages.get(item.package_id)?.prepared_by])]
    .filter((id): id is string => typeof id === "string" && id.length > 0))]
  const profilesResult = actorIds.length ? await admin.from("profiles").select("id,nombre,username,email").in("id", actorIds) : { data: [], error: null }
  if (profilesResult.error) throw profilesResult.error
  const actors = new Map((profilesResult.data ?? []).map((item) => [item.id, item.nombre || item.username || item.email || item.id]))
  const name = (id: string | null | undefined) => id ? actors.get(id) ?? id : null
  const items = memberships.map((item) => ({ orderId: item.order_id, parcelCount: packages.get(item.package_id)?.parcel_count ?? 0, cancelled: cancelled.has(item.order_id),
    removedAt: item.removed_at, removalReason: item.removal_reason, preparedBy: name(packages.get(item.package_id)?.prepared_by),
    controlledBy: name(item.verified_by), removedBy: name(item.removed_by) }))
  return { batch: { id: batch.id, code: batch.code, display_number: batch.display_number, status: batch.status,
    created_at: batch.created_at, closed_at: batch.closed_at, handed_over_at: batch.handed_over_at },
    orderCount: items.filter((item) => !item.removedAt).length,
    parcelCount: items.filter((item) => !item.removedAt).reduce((sum, item) => sum + item.parcelCount, 0),
    preparedBy: [...new Set(items.filter((item) => !item.removedAt).map((item) => item.preparedBy).filter((item): item is string => Boolean(item)))],
    assembledBy: name(batch.created_by), controlledBy: [...new Set(items.map((item) => item.controlledBy).filter((item): item is string => Boolean(item)))],
    deliveredBy: name(batch.handed_over_by), items }
}
