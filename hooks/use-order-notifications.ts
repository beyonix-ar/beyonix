"use client"

import { useCallback, useEffect, useState } from "react"

import {
  ORDER_NOTIFICATIONS_CHANGED_EVENT,
  getSupabaseErrorDetails,
  getNewOrderNotificationCount,
} from "@/lib/admin/order-notifications"
import { supabase } from "@/lib/supabase/client"

export function useOrderNotifications() {
  const [notificationCount, setNotificationCount] = useState(0)

  const loadNotificationCount = useCallback(async () => {
    try {
      setNotificationCount(await getNewOrderNotificationCount())
    } catch (error) {
      setNotificationCount(0)
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
      .channel("admin-order-notifications")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "ordenes",
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
    reloadNotificationCount: loadNotificationCount,
  }
}
