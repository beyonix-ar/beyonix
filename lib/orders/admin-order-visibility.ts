export interface AdminOrderVisibilityRow {
  id: number
  created_at?: string | null
  admin_visible_at?: string | null
}

export function isAdminOrderVisible(order: AdminOrderVisibilityRow) {
  return (
    Number.isFinite(order.id) &&
    typeof order.admin_visible_at === "string" &&
    order.admin_visible_at.length > 0
  )
}

export function getAdminNewOrderEventAt(order: AdminOrderVisibilityRow) {
  return isAdminOrderVisible(order) ? order.admin_visible_at! : null
}

export function getAdminNewOrderEventKey(orderId: number) {
  return `order:${orderId}`
}
