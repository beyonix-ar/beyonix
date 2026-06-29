"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  BadgeCheck,
  Bell,
  CheckCheck,
  Clock3,
  MessageCircle,
  PackageCheck,
  Tag,
  Truck,
} from "lucide-react"

import {
  getCustomerNotifications,
  markAllCustomerNotificationsRead,
  markCustomerNotificationRead,
} from "@/lib/supabase/queries/customer-notifications"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseCustomerNotification } from "@/lib/supabase/types"

interface CustomerNotificationsBellProps {
  userId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function getNotificationIcon(type: string) {
  if (type === "payment_proof_pending") return Clock3
  if (type === "admin_message" || type === "claim_response") return MessageCircle
  if (type === "offer") return Tag
  if (type === "payment_validated") return BadgeCheck
  if (type === "order_shipped") return Truck
  if (type === "order_delivered") return PackageCheck
  return Bell
}

function formatRelativeDate(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return ""

  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const absoluteSeconds = Math.abs(seconds)

  if (absoluteSeconds < 60) return "Ahora"

  const formatter = new Intl.RelativeTimeFormat("es-AR", { numeric: "auto" })

  if (absoluteSeconds < 3600) {
    return formatter.format(Math.round(seconds / 60), "minute")
  }

  if (absoluteSeconds < 86400) {
    return formatter.format(Math.round(seconds / 3600), "hour")
  }

  if (absoluteSeconds < 604800) {
    return formatter.format(Math.round(seconds / 86400), "day")
  }

  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
  }).format(date)
}

function getNotificationActionUrl(notification: SupabaseCustomerNotification) {
  const actionUrl = notification.action_url

  if (!actionUrl?.startsWith("/") || !notification.order_id) return actionUrl

  const url = new URL(actionUrl, window.location.origin)
  if (url.pathname !== "/cuenta") return actionUrl

  const opensClaim =
    notification.type === "admin_message" ||
    notification.type === "claim_response"

  return `/cuenta/compras/${notification.order_id}${opensClaim ? "/ayuda" : ""}`
}

export function CustomerNotificationsBell({
  userId,
  open,
  onOpenChange,
}: CustomerNotificationsBellProps) {
  const router = useRouter()
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [notifications, setNotifications] = useState<SupabaseCustomerNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification.is_read).length,
    [notifications],
  )

  const loadNotifications = useCallback(async () => {
    try {
      const data = await getCustomerNotifications(userId)
      setNotifications(data)
      setError("")
    } catch (loadError) {
      console.error("CUSTOMER_NOTIFICATIONS_LOAD_ERROR", loadError)
      setError("No pudimos cargar tus notificaciones.")
    } finally {
      setLoading(false)
    }
  }, [userId])

  const clearCloseTimer = useCallback(() => {
    if (!closeTimerRef.current) return

    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const openPopover = useCallback(() => {
    clearCloseTimer()
    onOpenChange(true)
  }, [clearCloseTimer, onOpenChange])

  const scheduleClosePopover = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => {
      onOpenChange(false)
      closeTimerRef.current = null
    }, 500)
  }, [clearCloseTimer, onOpenChange])

  useEffect(() => {
    setLoading(true)
    void loadNotifications()

    const channel = supabase
      .channel(`customer-notifications-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "customer_notifications",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void loadNotifications()
        },
      )
      .subscribe()

    const handleFocus = () => {
      void loadNotifications()
    }

    window.addEventListener("focus", handleFocus)

    return () => {
      window.removeEventListener("focus", handleFocus)
      void supabase.removeChannel(channel)
    }
  }, [loadNotifications, userId])

  useEffect(() => {
    if (!open) return

    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target)) return
      onOpenChange(false)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false)
    }

    document.addEventListener("mousedown", handleOutside)
    document.addEventListener("keydown", handleEscape)

    return () => {
      document.removeEventListener("mousedown", handleOutside)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [onOpenChange, open])

  useEffect(() => {
    return () => {
      clearCloseTimer()
    }
  }, [clearCloseTimer])

  const handleNotificationClick = async (
    notification: SupabaseCustomerNotification,
  ) => {
    if (!notification.is_read) {
      setNotifications((current) =>
        current.map((item) =>
          item.id === notification.id ? { ...item, is_read: true } : item,
        ),
      )

      try {
        await markCustomerNotificationRead(notification.id, userId)
      } catch (markError) {
        console.error("CUSTOMER_NOTIFICATION_READ_ERROR", markError)
        void loadNotifications()
      }
    }

    clearCloseTimer()
    onOpenChange(false)

    const actionUrl = getNotificationActionUrl(notification)

    if (actionUrl?.startsWith("/")) {
      router.push(actionUrl)
    }
  }

  const handleMarkAllRead = useCallback(async () => {
    if (unreadCount === 0) return

    setNotifications((current) =>
      current.map((notification) => ({ ...notification, is_read: true })),
    )

    try {
      await markAllCustomerNotificationsRead(userId)
    } catch (markError) {
      console.error("CUSTOMER_NOTIFICATIONS_READ_ALL_ERROR", markError)
      void loadNotifications()
    }
  }, [loadNotifications, unreadCount, userId])

  useEffect(() => {
    if (!open || loading || unreadCount === 0) return

    void handleMarkAllRead()
  }, [handleMarkAllRead, loading, open, unreadCount])

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onMouseEnter={openPopover}
      onMouseLeave={scheduleClosePopover}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label="Abrir notificaciones"
        title="Notificaciones"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        onFocus={openPopover}
        className="relative flex size-10 cursor-pointer items-center justify-center rounded-full border border-[#303846] bg-[#0D1117] text-white/80 transition-all hover:border-beyonix-blue-light hover:bg-[#141820] hover:text-white hover:shadow-[0_0_18px_rgba(17,42,67,0.55)]"
      >
        <Bell className="size-4.5" />

        {unreadCount > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex min-w-5 h-5 items-center justify-center rounded-full border border-black bg-red-600 px-1 text-9px font-bold leading-none text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-12 z-100 w-80 max-w-[calc(100vw-2rem)] sm:w-96"
          onMouseEnter={openPopover}
          onMouseLeave={scheduleClosePopover}
        >
        <div ref={panelRef} className="w-full overflow-hidden rounded-2xl border border-[#303846] bg-[#0D1117] font-heading shadow-2xl shadow-black/75">
          <div className="flex items-center justify-between gap-3 border-b border-[#303846] px-4 py-3">
            <div>
              <h2 className="text-sm font-bold text-white">Notificaciones</h2>
              {unreadCount > 0 && (
                <p className="mt-0.5 text-10px text-[#9CA3AF]">
                  {unreadCount} sin leer
                </p>
              )}
            </div>

            {unreadCount > 0 && (
              <button
                type="button"
                title="Marcar todas como leídas"
                aria-label="Marcar todas las notificaciones como leídas"
                onClick={() => void handleMarkAllRead()}
                className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-[#9CA3AF] transition-colors hover:bg-[#1B2028] hover:text-white"
              >
                <CheckCheck className="size-4" />
              </button>
            )}
          </div>

          <div className="custom-scrollbar max-h-[min(440px,65vh)] overflow-y-auto p-2">
            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((item) => (
                  <div
                    key={item}
                    className="h-24 animate-pulse rounded-xl border border-[#303846] bg-[#141820]"
                  />
                ))}
              </div>
            ) : error ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm font-semibold text-white">No pudimos cargar las notificaciones</p>
                <button
                  type="button"
                  onClick={() => {
                    setLoading(true)
                    void loadNotifications()
                  }}
                  className="mt-3 cursor-pointer text-xs font-semibold text-beyonix-sky hover:text-white"
                >
                  Reintentar
                </button>
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-5 py-9 text-center">
                <span className="mx-auto flex size-11 items-center justify-center rounded-full border border-[#303846] bg-[#141820] text-[#9CA3AF]">
                  <Bell className="size-5" />
                </span>
                <p className="mt-3 text-sm font-semibold text-white">
                  No tenés notificaciones por ahora
                </p>
                <p className="mt-1.5 text-xs leading-5 text-[#9CA3AF]">
                  Te avisaremos acá cuando haya novedades sobre tus compras.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {notifications.map((notification) => {
                  const NotificationIcon = getNotificationIcon(notification.type)

                  return (
                    <button
                      key={notification.id}
                      type="button"
                      onClick={() => void handleNotificationClick(notification)}
                      className="group flex w-full cursor-pointer items-start gap-3 rounded-xl border border-[#303846] bg-[#141820] p-3 text-left transition-colors hover:bg-[#1B2028]"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-light/20 bg-beyonix-blue/25 text-beyonix-sky">
                        <NotificationIcon className="size-4" />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 text-sm font-semibold leading-5 text-white">
                            {notification.title}
                          </span>
                          {!notification.is_read && (
                            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.7)]" />
                          )}
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-[#C8C8C8]">
                          {notification.body}
                        </span>
                        <span className="mt-1 block text-10px text-[#9CA3AF]">
                          {formatRelativeDate(notification.created_at)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
        </div>
      )}
    </div>
  )
}
