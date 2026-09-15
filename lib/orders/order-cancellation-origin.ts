import type { SupabaseOrderAuditEvent } from "@/lib/supabase/types"

// Deriva quién y por qué se canceló/rechazó un pedido a partir de
// order_audit_events -- misma fuente de verdad que ya usa el admin
// (antes vivía inline en buildOrderTimeline, en
// app/admin/sections/pedidos/admin-pedidos.tsx). Se extrajo a un helper
// compartido para que el panel de Cancelación del admin y "Mis compras"
// del cliente usen exactamente el mismo criterio, en vez de tener cada
// uno su propia lógica (la del panel de Cancelación era más pobre y
// producía el texto ambiguo "Cancelación cerrada" para rechazos).
//
// No inventa ningún estado nuevo: sólo interpreta datos ya existentes.

export type OrderCancellationOrigin = "cliente" | "administrador" | "automático" | null

export type OrderCancellationInfo = {
  auditEvent: SupabaseOrderAuditEvent | null
  origin: OrderCancellationOrigin
  rejectedByAdmin: boolean
  title: string
  description: string
  reasonText: string | null
  cancelledAt: string | null
}

type OrderForCancellationOrigin = {
  cancellation_requested_at?: string | null
  cancelled_at?: string | null
  cancellation_requested_by?: string | null
}

export function deriveOrderCancellationInfo(
  auditEvents: SupabaseOrderAuditEvent[] | null | undefined,
  order: OrderForCancellationOrigin,
): OrderCancellationInfo {
  const events = auditEvents ?? []
  const cancellationAuditEvent =
    events.find(
      (event) =>
        event.created_at &&
        [
          "cancellation_requested",
          "cancellation_requested_refund_pending",
          "order_cancelled_refund_pending",
          "order_rejected_by_admin",
          "order_status_changed",
        ].includes(event.action) &&
        (event.new_status === "cancelled" ||
          event.new_status === "refund_pending" ||
          event.new_status === "cancelado" ||
          event.metadata?.newEstado === "cancelado"),
    ) ?? null

  const rejectedByAdmin = cancellationAuditEvent?.action === "order_rejected_by_admin"

  const origin: OrderCancellationOrigin =
    cancellationAuditEvent?.actor_type === "customer" ||
    cancellationAuditEvent?.action.startsWith("cancellation_requested")
      ? "cliente"
      : cancellationAuditEvent?.actor_type === "admin" ||
          cancellationAuditEvent?.action === "order_cancelled_refund_pending" ||
          rejectedByAdmin
        ? "administrador"
        : cancellationAuditEvent?.actor_type === "system"
          ? "automático"
          : order.cancellation_requested_by
            ? "cliente"
            : null

  const reasonText =
    typeof cancellationAuditEvent?.metadata?.reasonText === "string"
      ? (cancellationAuditEvent.metadata.reasonText as string)
      : null

  const title =
    origin === "administrador" && rejectedByAdmin
      ? "Pedido rechazado por el administrador"
      : origin === "cliente"
        ? "Pedido cancelado por el cliente"
        : origin === "administrador"
          ? "Pedido cancelado por el administrador"
          : origin === "automático"
            ? "Pedido cancelado automáticamente"
            : "Pedido cancelado"

  const description =
    origin === "administrador" && rejectedByAdmin
      ? reasonText
        ? `Un administrador rechazó el pedido. Motivo: ${reasonText}.`
        : "Un administrador rechazó el pedido."
      : origin === "cliente"
        ? "El cliente solicitó la cancelación del pedido."
        : origin === "administrador"
          ? reasonText
            ? `Un administrador canceló el pedido. Motivo: ${reasonText}.`
            : "Un administrador canceló el pedido."
          : origin === "automático"
            ? "El sistema interrumpió el flujo del pedido."
            : "La compra fue cancelada."

  const cancelledAt =
    order.cancellation_requested_at || order.cancelled_at || cancellationAuditEvent?.created_at || null

  return {
    auditEvent: cancellationAuditEvent,
    origin,
    rejectedByAdmin,
    title,
    description,
    reasonText,
    cancelledAt,
  }
}
