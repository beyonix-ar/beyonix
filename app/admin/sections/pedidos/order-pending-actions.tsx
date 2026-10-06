"use client"

import Link from "next/link"

import {
  summarizeAdminPendingActions,
  type AdminPendingOrderAction,
} from "@/lib/orders/admin-pending-actions"

/**
 * Etiquetas humanas de la fila: qué hay que hacer y a dónde ir. Sólo
 * navegación; las reglas viven en getAdminPendingOrderActions.
 */
export function OrderPendingActionChips({
  actions,
  visible,
}: {
  actions: AdminPendingOrderAction[]
  visible: number
}) {
  if (actions.length === 0) return null
  const { shown, hidden } = summarizeAdminPendingActions(actions, visible)
  const hiddenLabels = actions
    .filter((action) => !shown.some((item) => item.label === action.label))
    .map((action) => action.label)

  return (
    <div className="admin-order-action-chips" data-testid="order-pending-actions">
      {shown.map((action) => (
        <Link
          key={action.label}
          href={action.href}
          data-priority={action.priority}
          className={`admin-order-action-chip ${action.urgent ? "admin-order-tone-danger" : "admin-order-tone-warning"}`}
        >
          {action.label}
        </Link>
      ))}
      {hidden > 0 && (
        <span className="admin-order-action-chip admin-order-tone-muted" title={hiddenLabels.join(" · ")}>
          {hidden === 1 ? "+1 pendiente" : `+${hidden} pendientes`}
        </span>
      )}
    </div>
  )
}
