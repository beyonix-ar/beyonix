export const ADMIN_SENSITIVE_DANGER = {
  action: "border-[#9f3546]/70 bg-[#2a1117] text-[#ffc2c8] hover:border-[#bf4a5b] hover:bg-[#35151d] hover:text-white",
  actionSolid: "border-[#9f3546] bg-[#7f2d3a] text-white hover:border-[#bf4a5b] hover:bg-[#9f3546]",
  badge: "admin-order-tone-danger border-[#9f3546]/65 bg-[#2a1117] text-[#ffc2c8]",
  card: "border-[#7f2d3a]/60 bg-[#0D1117] shadow-[0_0_18px_rgba(159,53,70,0.08)] hover:border-[#9f3546]/80 hover:bg-[#111820]",
  dot: "bg-[#ff4d61] shadow-[0_0_10px_rgba(255,77,97,0.78)]",
  icon: "border-[#9f3546]/65 bg-[#2a1117] text-[#ffc2c8]",
  label: "text-[#ffb4bd]",
  panel: "border-[#7f2d3a]/65 bg-[#0D1117]",
  panelSoft: "border-[#7f2d3a]/55 bg-[#111827]",
  textMuted: "text-[#f4b8c0]/72",
} as const

export function isAdminSensitiveStatus(value?: string | null) {
  const normalized = (value ?? "").toLowerCase()

  return (
    normalized.includes("cancel") ||
    normalized.includes("reclamo") ||
    normalized.includes("claim") ||
    normalized.includes("refund_pending") ||
    normalized.includes("reintegro pendiente") ||
    normalized.includes("devolucion pendiente") ||
    normalized.includes("devolución pendiente")
  )
}

type AdminSensitiveNotificationLike = {
  actionLabel?: string
  actionUrl?: string
  body?: string
  priority?: string
  title?: string
  type?: string
}

function getAdminSensitiveNotificationText(
  notification?: AdminSensitiveNotificationLike | null,
) {
  if (!notification) return ""

  return [
    notification.title,
    notification.body,
    notification.actionLabel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

export function isAdminClaimSensitiveNotification(
  notification?: AdminSensitiveNotificationLike | null,
) {
  const text = getAdminSensitiveNotificationText(notification)

  return Boolean(
    notification?.type === "claim" ||
    notification?.actionUrl?.includes("tab=reclamos") ||
    text.includes("reclamo") ||
    text.includes("claim"),
  )
}

export function isAdminCancellationSensitiveNotification(
  notification?: AdminSensitiveNotificationLike | null,
) {
  const text = getAdminSensitiveNotificationText(notification)

  return Boolean(
    notification?.type === "cancellation" ||
    notification?.priority === "attention" ||
    notification?.actionUrl?.includes("tab=cancelacion") ||
    text.includes("cancel") ||
    text.includes("refund_pending") ||
    text.includes("reintegro pendiente") ||
    text.includes("devolucion pendiente") ||
    text.includes("devolución pendiente"),
  )
}

export function isAdminSensitiveNotification(
  notification?: AdminSensitiveNotificationLike | null,
) {
  return (
    isAdminClaimSensitiveNotification(notification) ||
    isAdminCancellationSensitiveNotification(notification) ||
    isAdminSensitiveStatus(notification?.title) ||
    isAdminSensitiveStatus(notification?.body) ||
    isAdminSensitiveStatus(notification?.actionLabel)
  )
}
