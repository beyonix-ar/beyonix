"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  ADMIN_NOTIFICATIONS_CHANGED_EVENT,
  getAdminNotifications,
  getSupabaseErrorDetails,
  type AdminNotification,
  type AdminNotificationGroups,
  type AdminNotificationTone,
} from "@/lib/admin/admin-notifications"
import { supabase } from "@/lib/supabase/client"

const EMPTY_GROUPS: AdminNotificationGroups = {
  order: 0,
  message: 0,
  payment: 0,
  giftcard: 0,
  invoice: 0,
  shipping: 0,
  cancellation: 0,
  claim: 0,
}

const REALTIME_TABLES = [
  "ordenes",
  "orden_items",
  "admin_events",
  "order_claims",
  "order_claim_messages",
  "order_claim_files",
  "order_refund_proofs",
  "order_audit_events",
  "admin_order_views",
  "admin_order_event_views",
  "admin_notification_reads",
  "customer_credit_topups",
  "customer_credit_movements",
  "customer_gift_cards",
] as const

const FALLBACK_REFRESH_INTERVAL_MS = 4_000

export function useAdminNotifications(enabled = true) {
  const requestId = useRef(0)
  const [notificationCount, setNotificationCount] = useState(0)
  const [notificationTone, setNotificationTone] =
    useState<AdminNotificationTone>("order")
  const [notificationGroups, setNotificationGroups] =
    useState<AdminNotificationGroups>(EMPTY_GROUPS)
  const [notifications, setNotifications] = useState<AdminNotification[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState("")
  const channelName = useRef(
    `admin-notifications-${Math.random().toString(36).slice(2)}`,
  )

  const loadNotifications = useCallback(async () => {
    const currentRequestId = ++requestId.current

    if (!enabled) {
      setNotificationCount(0)
      setNotificationTone("order")
      setNotificationGroups(EMPTY_GROUPS)
      setNotifications([])
      setLoading(false)
      setError("")
      return
    }

    try {
      const summary = await getAdminNotifications()
      if (currentRequestId !== requestId.current) return

      setNotificationCount(summary.count)
      setNotificationTone(summary.tone)
      setNotificationGroups(summary.groups)
      setNotifications(summary.notifications)
      setError("")
    } catch (loadError) {
      if (currentRequestId !== requestId.current) return

      console.error(
        "ADMIN_NOTIFICATIONS_LOAD_ERROR",
        getSupabaseErrorDetails(loadError),
      )
      setError("No pudimos cargar las notificaciones.")
    } finally {
      if (currentRequestId === requestId.current) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    setLoading(enabled)
    void loadNotifications()

    window.addEventListener(
      ADMIN_NOTIFICATIONS_CHANGED_EVENT,
      loadNotifications,
    )

    return () => {
      window.removeEventListener(
        ADMIN_NOTIFICATIONS_CHANGED_EVENT,
        loadNotifications,
      )
    }
  }, [enabled, loadNotifications])

  useEffect(() => {
    if (!enabled) return

    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        void loadNotifications()
      }, 180)
    }

    let channel = supabase.channel(channelName.current)

    for (const table of REALTIME_TABLES) {
      channel = channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
        },
        scheduleReload,
      )
    }

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") scheduleReload()
    })

    return () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      void supabase.removeChannel(channel)
    }
  }, [enabled, loadNotifications])

  useEffect(() => {
    if (!enabled) return

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void loadNotifications()
    }

    const fallbackInterval = window.setInterval(
      refreshIfVisible,
      FALLBACK_REFRESH_INTERVAL_MS,
    )

    window.addEventListener("focus", refreshIfVisible)
    window.addEventListener("online", refreshIfVisible)
    document.addEventListener("visibilitychange", refreshIfVisible)

    return () => {
      window.clearInterval(fallbackInterval)
      window.removeEventListener("focus", refreshIfVisible)
      window.removeEventListener("online", refreshIfVisible)
      document.removeEventListener("visibilitychange", refreshIfVisible)
    }
  }, [enabled, loadNotifications])

  return {
    notificationCount,
    notificationTone,
    notificationGroups,
    notifications,
    loading,
    error,
    reloadNotifications: loadNotifications,
  }
}
