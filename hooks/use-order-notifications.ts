"use client"

import { useAdminNotifications } from "@/hooks/use-admin-notifications"

export function useOrderNotifications(enabled = true) {
  const notifications = useAdminNotifications(enabled)

  return {
    notificationCount: notifications.notificationCount,
    notificationTone: notifications.notificationTone,
    notificationGroups: notifications.notificationGroups,
    notifications: notifications.notifications,
    loading: notifications.loading,
    error: notifications.error,
    reloadNotificationCount: notifications.reloadNotifications,
  }
}
