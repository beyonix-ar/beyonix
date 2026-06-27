"use client"

import {
  Bell,
  CreditCard,
  FileText,
  MessageCircle,
  ShieldAlert,
  ShoppingCart,
  Truck,
  XCircle,
} from "lucide-react"

import {
  markAdminNotificationRead,
  type AdminNotification,
  type AdminNotificationType,
} from "@/lib/admin/admin-notifications"
import { cn } from "@/lib/utils"

const TYPE_LABELS: Record<AdminNotificationType, string> = {
  order: "Pedido nuevo",
  message: "Mensaje nuevo",
  payment: "Comprobante nuevo",
  invoice: "Factura por emitir",
  shipping: "Envío pendiente",
  cancellation: "Compra cancelada",
  claim: "Reclamo por responder",
}

const TYPE_STYLES: Record<AdminNotificationType, string> = {
  order: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  message: "border-sky-400/25 bg-sky-400/10 text-sky-200",
  payment: "border-blue-400/25 bg-blue-400/10 text-blue-200",
  invoice: "border-violet-400/25 bg-violet-400/10 text-violet-200",
  shipping: "border-[#77E6E2]/25 bg-[#77E6E2]/5 text-[#77E6E2]",
  cancellation: "border-orange-400/30 bg-orange-500/12 text-orange-200",
  claim: "border-red-400/25 bg-red-400/10 text-red-200",
}

const TYPE_UNREAD_DOT_STYLES: Record<AdminNotificationType, string> = {
  order: "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.75)]",
  message: "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.75)]",
  payment: "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.75)]",
  invoice: "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.75)]",
  shipping: "bg-[#77E6E2]",
  cancellation: "bg-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.75)]",
  claim: "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.75)]",
}

function getNotificationIcon(type: AdminNotificationType) {
  if (type === "order") return ShoppingCart
  if (type === "message") return MessageCircle
  if (type === "payment") return CreditCard
  if (type === "invoice") return FileText
  if (type === "shipping") return Truck
  if (type === "cancellation") return XCircle
  if (type === "claim") return ShieldAlert
  return Bell
}

function formatNotificationDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""

  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date)
}

interface AdminNotificationsPopoverProps {
  notifications: AdminNotification[]
  loading?: boolean
  error?: string
  onNotificationClick: (notification: AdminNotification) => void
  onRetry?: () => void
}

export function AdminNotificationsPopover({
  notifications,
  loading = false,
  error = "",
  onNotificationClick,
  onRetry,
}: AdminNotificationsPopoverProps) {
  return (
    <div className="w-full overflow-hidden rounded-2xl border border-[#303846] bg-[#0D1117] font-heading shadow-2xl shadow-black/75">
      <div className="border-b border-[#303846] px-4 py-3">
        <p className="text-sm font-black text-white">Notificaciones admin</p>
        <p className="mt-0.5 text-10px text-white/50">
          {notifications.length > 0
            ? `${notifications.length} pendientes`
            : "Todo está al día"}
        </p>
      </div>

      <div className="custom-scrollbar max-h-[min(460px,68vh)] overflow-y-auto p-2">
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
            <p className="text-sm font-semibold text-white">
              No pudimos cargar las notificaciones
            </p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-3 cursor-pointer text-xs font-semibold text-beyonix-sky hover:text-white"
              >
                Reintentar
              </button>
            )}
          </div>
        ) : notifications.length === 0 ? (
          <div className="px-5 py-9 text-center">
            <span className="mx-auto flex size-11 items-center justify-center rounded-full border border-[#303846] bg-[#141820] text-white/50">
              <Bell className="size-5" />
            </span>
            <p className="mt-3 text-sm font-semibold text-white">
              No hay alertas pendientes
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {notifications.map((notification) => {
              const Icon = getNotificationIcon(notification.type)
              const attention = notification.priority === "attention"

              return (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => onNotificationClick(notification)}
                  className={cn(
                    "group flex w-full cursor-pointer items-start gap-3 rounded-xl border bg-[#141820] p-3 text-left transition-all hover:bg-[#1B2028]",
                    attention
                      ? "border-orange-300/35 shadow-[0_0_18px_rgba(251,146,60,0.10)] hover:border-orange-300/50 hover:shadow-[0_0_0_1px_rgba(251,146,60,0.20)]"
                      : "border-[#303846] hover:border-[#1e6fae] hover:shadow-[0_0_0_1px_rgba(30,111,174,0.35)]",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-lg border",
                      TYPE_STYLES[notification.type],
                      attention && "border-orange-300/40 bg-orange-500/16 text-orange-100",
                    )}
                  >
                    <Icon className="size-4" />
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 text-10px font-black uppercase tracking-wide text-beyonix-cyan">
                        {TYPE_LABELS[notification.type]}
                      </span>
                      {!notification.isRead && (
                        <span
                          className={cn(
                            "mt-1 size-2 shrink-0 rounded-full",
                            TYPE_UNREAD_DOT_STYLES[notification.type],
                          )}
                        />
                      )}
                    </span>
                    <span className="mt-1 block text-sm font-semibold leading-5 text-white">
                      {notification.title}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-white/65">
                      {notification.body}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-2 text-10px text-white/42">
                      <span>{formatNotificationDate(notification.eventAt)}</span>
                      {notification.actionLabel && (
                        <span className="font-black text-beyonix-sky group-hover:text-white">
                          {notification.actionLabel}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export async function handleAdminNotificationClick(
  notification: AdminNotification,
) {
  await markAdminNotificationRead(notification)
}
