import "server-only"

import type { SupabaseOrderAuditEvent } from "@/lib/supabase/types"

/**
 * Único lugar que decide qué claves de order_audit_events.metadata puede ver
 * el cliente final. El resto (andreaniSnapshot, envioId, environment, notes
 * de conciliación Andreani, reasonCode, source interno, previousEstado,
 * claimId, etc.) es operativo/administrativo y sólo debe salir por rutas
 * admin -- ver auditoría Andreani Parte 4/4 (GET /api/orders exponía
 * order_audit_events.metadata completo al cliente dueño del pedido).
 */
const CUSTOMER_VISIBLE_METADATA_KEYS = ["reasonText", "newEstado"] as const

type CustomerVisibleMetadataKey = (typeof CUSTOMER_VISIBLE_METADATA_KEYS)[number]

export type CustomerSafeOrderAuditEvent = {
  action: string
  actor_type: SupabaseOrderAuditEvent["actor_type"]
  new_status: string | null
  created_at: string
  metadata: Partial<Record<CustomerVisibleMetadataKey, string>> | null
}

export function toCustomerSafeOrderAuditEvent(
  event: SupabaseOrderAuditEvent,
): CustomerSafeOrderAuditEvent {
  const metadata = event.metadata ?? null
  const safeMetadata: Partial<Record<CustomerVisibleMetadataKey, string>> = {}

  if (metadata) {
    for (const key of CUSTOMER_VISIBLE_METADATA_KEYS) {
      const value = metadata[key]
      if (typeof value === "string") safeMetadata[key] = value
    }
  }

  return {
    action: event.action,
    actor_type: event.actor_type,
    new_status: event.new_status ?? null,
    created_at: event.created_at,
    metadata: Object.keys(safeMetadata).length > 0 ? safeMetadata : null,
  }
}

/**
 * Acciones que el cliente necesita (origen de una cancelación, ver
 * lib/orders/order-cancellation-origin.ts). Los eventos operativos (armado,
 * variantes, bultos, conciliación, envíos) nunca salen hacia el cliente.
 */
export const CUSTOMER_VISIBLE_AUDIT_ACTIONS = [
  "cancellation_requested",
  "cancellation_requested_refund_pending",
  "order_cancelled_refund_pending",
  "order_rejected_by_admin",
  "order_status_changed",
] as const

export function toCustomerSafeOrderAuditEvents(
  events: SupabaseOrderAuditEvent[] | null | undefined,
): CustomerSafeOrderAuditEvent[] {
  return (events ?? [])
    .filter((event) => (CUSTOMER_VISIBLE_AUDIT_ACTIONS as readonly string[]).includes(event.action))
    .map(toCustomerSafeOrderAuditEvent)
}
