"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Bell } from "lucide-react"

import {
  markAdminNotificationRead,
  type AdminNotification,
  type AdminNotificationGroups,
  type AdminNotificationTone,
} from "@/lib/admin/admin-notifications"
import {
  ADMIN_ATTENTION_WARNING,
  ADMIN_SENSITIVE_DANGER,
  isAdminSensitiveNotification,
} from "@/lib/admin/admin-sensitive-visuals"
import { AdminNotificationsPopover } from "@/components/admin-notifications-popover"
import { cn } from "@/lib/utils"

const ADMIN_NEUTRAL_BELL_STYLE =
  "admin-ds-notification-bell"
const ADMIN_NEUTRAL_BADGE_STYLE = "admin-ds-notification-count"
const ADMIN_INCOMING_PAYMENT_BELL_STYLE = "admin-ds-bell-button-payment"
const ADMIN_INCOMING_PAYMENT_BADGE_STYLE = "admin-ds-notification-count-payment"

// Variante "storefront": este mismo componente se reutiliza fuera del panel
// admin (SiteHeader, badge flotante de checkout) -- ahí NO está dentro de
// .beyonix-admin-shell, así que las clases admin-ds-* (pensadas y sólo
// themeadas para data-admin-theme) no tienen ningún override de light
// disponible en ese contexto y quedan con su valor base fijo. La variante
// "storefront" usa clases propias, themeadas con data-account-theme (el
// mismo mecanismo que header/carrito/dropdown de usuario), dejando
// admin-ds-* -- y por lo tanto el panel admin real -- completamente
// intactos.
const STOREFRONT_NEUTRAL_BELL_STYLE = "beyonix-header-notif-bell"
const STOREFRONT_NEUTRAL_BADGE_STYLE = "beyonix-header-notif-badge"

interface AdminNotificationBellProps {
  count: number
  tone: AdminNotificationTone
  groups: AdminNotificationGroups
  notifications: AdminNotification[]
  loading?: boolean
  error?: string
  onRetry?: () => void
  align?: "start" | "end"
  variant?: "admin" | "storefront"
}

export function AdminNotificationBell({
  count,
  tone,
  groups,
  notifications,
  loading = false,
  error = "",
  onRetry,
  align = "end",
  variant = "admin",
}: AdminNotificationBellProps) {
  const isStorefront = variant === "storefront"
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCloseTimer = () => {
    if (!closeTimerRef.current) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }

  const openPopover = () => {
    clearCloseTimer()
    setOpen(true)
  }

  const scheduleClosePopover = () => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, 500)
  }

  useEffect(() => {
    if (!open) return

    const handleOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }

    document.addEventListener("mousedown", handleOutside)
    document.addEventListener("keydown", handleEscape)
    return () => {
      document.removeEventListener("mousedown", handleOutside)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [open])

  useEffect(() => {
    return () => {
      clearCloseTimer()
    }
  }, [])

  const handleNotificationClick = async (notification: AdminNotification) => {
    clearCloseTimer()
    setOpen(false)
    if (
      notification.type !== "payment" &&
      notification.type !== "shipping" &&
      notification.type !== "mercadolibre_return"
    ) {
      await markAdminNotificationRead(notification)
    }
    router.push(notification.actionUrl)
  }

  const mercadoLibreReturnTone =
    tone === "mercadolibre_return" &&
    groups.mercadolibre_return > 0
  const sensitiveTone =
    !mercadoLibreReturnTone &&
    (tone === "cancellation" ||
      tone === "claim" ||
      notifications.some(
        (notification) =>
          notification.type !== "mercadolibre_return" &&
          isAdminSensitiveNotification(notification),
      ))
  const incomingPaymentTone = notifications.some((notification) =>
    notification.eventKey.startsWith("balance-topup:"),
  )

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={openPopover}
      onMouseLeave={scheduleClosePopover}
    >
      <button
        type="button"
        aria-label="Abrir notificaciones administrativas"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onFocus={openPopover}
        className={cn(
          isStorefront ? "beyonix-header-notif-trigger" : "admin-ds-bell-button",
          "relative flex size-11 cursor-pointer items-center justify-center rounded-full border transition-all",
          !isStorefront && "text-white",
          isStorefront && "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--account-focus-ring)]",
          count > 0
            ? mercadoLibreReturnTone
              ? ADMIN_ATTENTION_WARNING.action
              : sensitiveTone
                ? ADMIN_SENSITIVE_DANGER.action
                : incomingPaymentTone
                  ? ADMIN_INCOMING_PAYMENT_BELL_STYLE
                  : isStorefront
                    ? STOREFRONT_NEUTRAL_BELL_STYLE
                    : ADMIN_NEUTRAL_BELL_STYLE
            : isStorefront
              ? STOREFRONT_NEUTRAL_BELL_STYLE
              : "admin-ds-bell-button-idle",
        )}
      >
        <Bell className="size-4" />
        {count > 0 && (
          <span
            className={cn(
              "absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-9px font-medium leading-none",
              mercadoLibreReturnTone
                ? `${ADMIN_ATTENTION_WARNING.dot} text-black`
                : sensitiveTone
                  ? `${ADMIN_SENSITIVE_DANGER.dot} text-black`
                  : incomingPaymentTone
                    ? ADMIN_INCOMING_PAYMENT_BADGE_STYLE
                    : isStorefront
                      ? STOREFRONT_NEUTRAL_BADGE_STYLE
                      : ADMIN_NEUTRAL_BADGE_STYLE,
            )}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className={cn(
            isStorefront ? "beyonix-header-notif-position" : "admin-ds-popover-position",
            "absolute top-[52px] z-100 w-80 sm:w-96",
            align === "start" ? "left-0" : "right-0",
          )}
          onMouseEnter={openPopover}
          onMouseLeave={scheduleClosePopover}
        >
          <AdminNotificationsPopover
            notifications={notifications}
            loading={loading}
            error={error}
            onRetry={onRetry}
            variant={variant}
            onNotificationClick={(notification) => {
              void handleNotificationClick(notification)
            }}
          />
        </div>
      )}
    </div>
  )
}
