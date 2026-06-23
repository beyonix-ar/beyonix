"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  ORDER_NOTIFICATIONS_CHANGED_EVENT,
  getSupabaseErrorDetails,
  getNewOrderNotificationSummary,
  type AdminOrderNotificationGroups,
  type AdminOrderNotificationTone,
} from "@/lib/admin/order-notifications"
import { supabase } from "@/lib/supabase/client"

export function useOrderNotifications(enabled = true) {
  const [notificationCount, setNotificationCount] = useState(0)
  const [notificationTone, setNotificationTone] =
    useState<AdminOrderNotificationTone>("order")
  const [notificationGroups, setNotificationGroups] =
    useState<AdminOrderNotificationGroups>({ order: 0, message: 0, issue: 0, invoice: 0 })
  const channelName = useRef(
    `admin-order-notifications-${Math.random().toString(36).slice(2)}`
  )

  const loadNotificationCount = useCallback(async () => {
    if (!enabled) {
      setNotificationCount(0)
      setNotificationTone("order")
      setNotificationGroups({ order: 0, message: 0, issue: 0, invoice: 0 })
      return
    }

    try {
      const summary = await getNewOrderNotificationSummary()
      setNotificationCount(summary.count)
      setNotificationTone(summary.tone)
      setNotificationGroups(summary.groups)
    } catch (error) {
      setNotificationCount(0)
      setNotificationTone("order")
      setNotificationGroups({ order: 0, message: 0, issue: 0, invoice: 0 })
      console.error(
        "ORDER_NOTIFICATIONS_LOAD_ERROR",
        getSupabaseErrorDetails(error)
      )
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return

    void loadNotificationCount()

    window.addEventListener(
      ORDER_NOTIFICATIONS_CHANGED_EVENT,
      loadNotificationCount
    )

    return () => {
      window.removeEventListener(
        ORDER_NOTIFICATIONS_CHANGED_EVENT,
        loadNotificationCount
      )
    }
  }, [enabled, loadNotificationCount])

  useEffect(() => {
    if (!enabled) return

    const channel = supabase
      .channel(channelName.current)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "ordenes",
        },
        () => {
          void loadNotificationCount()
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "order_claims",
        },
        () => {
          void loadNotificationCount()
        }
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "order_claim_messages",
        },
        () => {
          void loadNotificationCount()
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "admin_order_event_views",
        },
        () => {
          void loadNotificationCount()
        }
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [enabled, loadNotificationCount])

  return {
    notificationCount,
    notificationTone,
    notificationGroups,
    reloadNotificationCount: loadNotificationCount,
  }
}
