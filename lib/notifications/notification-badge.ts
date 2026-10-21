// Contador de la campana (cliente y admin): se deriva de la misma lista que
// muestra el desplegable, nunca de una consulta aparte.
export const NOTIFICATION_BADGE_MAX = 9

export function countUnreadNotifications<T>(notifications: readonly T[], isRead: (notification: T) => boolean) {
  return notifications.reduce((count, notification) => (isRead(notification) ? count : count + 1), 0)
}

export function formatNotificationBadgeCount(count: number) {
  if (!Number.isFinite(count) || count <= 0) return null
  return count > NOTIFICATION_BADGE_MAX ? `${NOTIFICATION_BADGE_MAX}+` : String(Math.floor(count))
}

export function getNotificationsButtonLabel(base: string, unreadCount: number) {
  if (unreadCount <= 0) return base
  return `${base} (${unreadCount} sin leer)`
}
