import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"

type AdminClient = ReturnType<typeof createAdminClient>

export type OrderAuditActorType = "customer" | "admin" | "system"

interface AppendOrderAuditEventPayload {
  orderId: number
  actorType: OrderAuditActorType
  actorId?: string | null
  action: string
  previousStatus?: string | null
  newStatus?: string | null
  metadata?: Record<string, unknown>
}

export async function appendOrderAuditEvent(
  admin: AdminClient,
  {
    orderId,
    actorType,
    actorId = null,
    action,
    previousStatus = null,
    newStatus = null,
    metadata = {},
  }: AppendOrderAuditEventPayload,
) {
  const { error } = await admin.from("order_audit_events").insert({
    order_id: orderId,
    actor_type: actorType,
    actor_id: actorId,
    action,
    previous_status: previousStatus,
    new_status: newStatus,
    metadata,
  })

  if (error) {
    console.warn("ORDER_AUDIT_EVENT_ERROR", {
      orderId,
      action,
      message: error.message,
    })
  }
}
