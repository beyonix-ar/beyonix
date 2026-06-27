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
import { AdminNotificationsPopover } from "@/components/admin-notifications-popover"
import { cn } from "@/lib/utils"

const BELL_STYLES: Record<AdminNotificationTone, string> = {
  order: "border-emerald-400/45 bg-emerald-600 hover:bg-emerald-700",
  message: "border-sky-400/45 bg-sky-600 hover:bg-sky-700",
  payment: "border-blue-400/45 bg-blue-600 hover:bg-blue-700",
  invoice: "border-violet-400/45 bg-violet-600 hover:bg-violet-700",
  shipping: "border-[#77E6E2]/25 bg-[#77E6E2]/5 text-[#77E6E2] hover:border-[#77E6E2]/40 hover:bg-[#77E6E2]/10",
  claim: "border-red-400/35 bg-red-500/20 text-red-100 hover:border-red-300/45 hover:bg-red-500/28",
}

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
            ? BELL_STYLES[tone]
            : "border-white/12 bg-[#0D1117] hover:border-[#1e6fae] hover:bg-[#15191F]",
        )}
      >
        <Bell className="size-4" />
        {count > 0 && (
          <span
            className={cn(
              "absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[7px] font-medium leading-none",
              tone === "shipping"
                ? "bg-[#77E6E2] text-black"
                : tone === "claim"
                  ? "bg-red-300 text-black"
                : "bg-white text-black",
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
