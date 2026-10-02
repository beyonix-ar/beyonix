import "server-only"

import { normalizeBulkTargetItems, resolveBulkTargetProducts } from "../pricing/bulk-price-targets.ts"
import type { createAdminClient } from "../supabase/admin.ts"
import { formatArgentinaDateTime } from "./argentina-time.ts"
import {
  COMMERCIAL_EVENT_COLUMNS,
  findFinancingConflict,
  findPriceConflict,
  isLegacyEvent,
  windowsOverlap,
  type CommercialEventRow,
  type ScheduledEventInput,
} from "./scheduled-events.ts"

type AdminClient = ReturnType<typeof createAdminClient>

const range = (event: CommercialEventRow) =>
  event.ends_at
    ? `${formatArgentinaDateTime(event.starts_at)} → ${formatArgentinaDateTime(event.ends_at)}`
    : formatArgentinaDateTime(event.starts_at)

/**
 * Conflicto REAL con otro evento (o `null`) antes de guardar:
 * - financiación: dos eventos que controlan la política en la misma franja;
 * - precios: otro evento que toca alguno de los mismos productos en la misma
 *   franja, o productos tomados ahora por un evento manual activo.
 * Eventos sobre productos distintos no chocan.
 */
export async function findScheduledEventConflict(
  admin: AdminClient,
  input: ScheduledEventInput,
  excludeId?: string,
): Promise<{ message: string } | { error: string } | null> {
  const { data, error } = await admin
    .from("product_bulk_events")
    .select(COMMERCIAL_EVENT_COLUMNS)
    .in("status", ["scheduled", "active", "error"])
  if (error) return { error: "No se pudieron revisar los eventos existentes." }
  const events = ((data ?? []) as unknown as CommercialEventRow[]).filter((event) => event.id !== excludeId)
  const candidate = { id: excludeId, startsAt: input.startsAt, endsAt: input.endsAt }

  if (input.eventType === "financing_policy") {
    const conflict = findFinancingConflict(candidate, events)
    return conflict
      ? { message: `Se superpone con el evento de financiación "${conflict.internal_name}" (${range(conflict)}).` }
      : null
  }

  const resolved = await resolveBulkTargetProducts(admin, input.scope, input.targetItems)
  if ("error" in resolved) return { error: resolved.error }
  if (!resolved.products.length) return { message: "El evento no alcanza ningún producto." }
  const names = new Map(resolved.products.map((product) => [product.id, product.nombre]))
  const describe = (ids: readonly number[]) =>
    ids.slice(0, 3).map((id) => `"${names.get(id) ?? id}"`).join(", ") + (ids.length > 3 ? ` y ${ids.length - 3} más` : "")

  // Productos tomados por un evento manual activo (sin fecha de fin).
  const legacyActive = new Map(
    events.filter((event) => isLegacyEvent(event) && event.status === "active").map((event) => [event.id, event]),
  )
  const lockedByLegacy = resolved.products.filter((product) => product.promo_event_id && legacyActive.has(product.promo_event_id))
  if (lockedByLegacy.length) {
    const owner = legacyActive.get(lockedByLegacy[0].promo_event_id as string)
    return {
      message: `${describe(lockedByLegacy.map((product) => product.id))} está tomado por el evento activo "${owner?.internal_name}". Pausalo antes.`,
    }
  }

  const others: Array<{ event: CommercialEventRow; productIds: number[] }> = []
  for (const event of events) {
    if (event.event_type !== "price_change" || !event.starts_at) continue
    if (!windowsOverlap(candidate, { startsAt: event.starts_at, endsAt: event.ends_at })) continue
    const theirs = await resolveBulkTargetProducts(admin, event.scope, normalizeBulkTargetItems(event.target_items))
    if ("error" in theirs) return { error: theirs.error }
    others.push({ event, productIds: theirs.products.map((product) => product.id) })
  }
  const conflict = findPriceConflict({ ...candidate, productIds: [...names.keys()] }, others)
  return conflict
    ? {
        message: `${describe(conflict.productIds)} ya tiene el evento "${conflict.event.internal_name}" en esa franja (${range(conflict.event)}).`,
      }
    : null
}
