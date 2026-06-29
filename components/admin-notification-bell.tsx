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
  ADMIN_SENSITIVE_DANGER,
  isAdminSensitiveNotification,
} from "@/lib/admin/admin-sensitive-visuals"
import { AdminNotificationsPopover } from "@/components/admin-notifications-popover"
import { cn } from "@/lib/utils"

const ADMIN_NEUTRAL_BELL_STYLE =
  "border-[#77E6E2]/25 bg-[#102034] text-[#D7FFFD] hover:border-[#77E6E2]/45 hover:bg-[#13283f] hover:text-white"
const ADMIN_NEUTRAL_BADGE_STYLE =
  "bg-[#77E6E2] text-black shadow-[0_0_10px_rgba(119,230,226,0.58)]"

interface AdminNotificationBellProps {
  count: number
  tone: AdminNotificationTone
  groups: AdminNotificationGroups
  notifications: AdminNotification[]
  loading?: boolean
  error?: string
  onRetry?: () => void
  align?: "start" | "end"
}

export function AdminNotificationBell({
  count,
  tone,
  groups: _groups,
  notifications,
  loading = false,
  error = "",
  onRetry,
  align = "end",
}: AdminNotificationBellProps) {
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
    if (notification.type !== "payment" && notification.type !== "shipping") {
      await markAdminNotificationRead(notification)
    }
    router.push(notification.actionUrl)
  }

  const sensitiveTone =
    tone === "cancellation" ||
    tone === "claim" ||
    notifications.some(isAdminSensitiveNotification)

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
          "relative flex size-10 cursor-pointer items-center justify-center rounded-full border text-white shadow-lg shadow-black/35 transition-all hover:shadow-[0_0_0_1px_rgba(30,111,174,0.45)]",
          count > 0
            ? sensitiveTone
              ? ADMIN_SENSITIVE_DANGER.action
              : ADMIN_NEUTRAL_BELL_STYLE
            : "border-white/12 bg-[#0D1117] hover:border-[#1e6fae] hover:bg-[#15191F]",
        )}
      >
        <Bell className="size-4" />
        {count > 0 && (
          <span
            className={cn(
              "absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[7px] font-medium leading-none",
              sensitiveTone
                ? `${ADMIN_SENSITIVE_DANGER.dot} text-black`
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
            "absolute top-12 z-100 w-80 max-w-[calc(100vw-2rem)] sm:w-96",
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
            onNotificationClick={(notification) => {
              void handleNotificationClick(notification)
            }}
          />
        </div>
      )}
    </div>
  )
}
