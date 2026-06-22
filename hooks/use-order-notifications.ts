"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  ORDER_NOTIFICATIONS_CHANGED_EVENT,
  getSupabaseErrorDetails,
  getNewOrderNotificationSummary,
  type AdminOrderNotificationTone,
} from "@/lib/admin/order-notifications"
import { supabase } from "@/lib/supabase/client"

export function useOrderNotifications() {
  const [notificationCount, setNotificationCount] = useState(0)
  const [notificationTone, setNotificationTone] =
    useState<AdminOrderNotificationTone>("order")
  const channelName = useRef(
    `admin-order-notifications-${Math.random().toString(36).slice(2)}`
  )

  const loadNotificationCount = useCallback(async () => {
    try {
      const summary = await getNewOrderNotificationSummary()
      setNotificationCount(summary.count)
      setNotificationTone(summary.tone)
    } catch (error) {
      setNotificationCount(0)
      setNotificationTone("order")
      console.error(
        "ORDER_NOTIFICATIONS_LOAD_ERROR",
        getSupabaseErrorDetails(error)
      )
    }
  }, [])

  useEffect(() => {
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
  }, [loadNotificationCount])

  useEffect(() => {
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
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [loadNotificationCount])

  return {
    notificationCount,
    notificationTone,
    reloadNotificationCount: loadNotificationCount,
  }
}
