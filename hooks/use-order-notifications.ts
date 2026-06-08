"use client"

import { useCallback, useEffect, useState } from "react"

import {
  ORDER_NOTIFICATIONS_CHANGED_EVENT,
  getOrderNotificationCount,
} from "@/lib/admin/order-notifications"
import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"

export function useOrderNotifications() {
  const [notificationCount, setNotificationCount] = useState(0)

  const loadNotificationCount = useCallback(async () => {
    const { data, error } = await supabase
      .from("ordenes")
      .select("estado, payment_status")

    if (error) {
      console.error("ORDER_NOTIFICATIONS_LOAD_ERROR", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      })
      return
    }

    setNotificationCount(
      getOrderNotificationCount((data ?? []) as SupabasePedido[])
    )
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

  return {
    notificationCount,
    reloadNotificationCount: loadNotificationCount,
  }
}
