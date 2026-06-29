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
import {
  ADMIN_SENSITIVE_DANGER,
  isAdminSensitiveNotification,
} from "@/lib/admin/admin-sensitive-visuals"
import { cn } from "@/lib/utils"

const TYPE_LABELS: Record<AdminNotificationType, string> = {
  order: "Pedido nuevo",
  message: "Mensaje nuevo",
  payment: "Pago / reintegro",
  invoice: "Factura por emitir",
  shipping: "Envío pendiente",
  cancellation: "Compra cancelada",
  claim: "Reclamo por responder",
}

const ADMIN_NEUTRAL_CARD_STYLE =
  "border-[#303846] bg-[#141820] hover:border-beyonix-blue-light/35 hover:bg-[#1B2028]"
const ADMIN_NEUTRAL_ICON_STYLE =
  "border-white/10 bg-[#0D1117] text-white/58 group-hover:border-beyonix-blue-light/30 group-hover:text-beyonix-sky"
const ADMIN_NEUTRAL_DOT_STYLE =
  "bg-[#77E6E2] shadow-[0_0_8px_rgba(119,230,226,0.55)]"

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
              const sensitive = isAdminSensitiveNotification(notification)
              return (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => onNotificationClick(notification)}
                  className={cn(
                    "group flex w-full cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-left transition-all",
                    sensitive
                      ? ADMIN_SENSITIVE_DANGER.card
                      : ADMIN_NEUTRAL_CARD_STYLE,
                  )}
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg border",
                      sensitive
                        ? ADMIN_SENSITIVE_DANGER.icon
                        : ADMIN_NEUTRAL_ICON_STYLE,
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-start gap-2">
                      <span
                        className={cn(
                          "min-w-0 flex-1 text-[13px] font-bold uppercase tracking-normal leading-4",
                          sensitive ? ADMIN_SENSITIVE_DANGER.label : "text-white/64",
                        )}
                      >
                        {TYPE_LABELS[notification.type]}
                      </span>
                      {!notification.isRead && (
                        <span
                          className={cn(
                            "mt-1 size-1.5 shrink-0 rounded-full",
                            sensitive
                              ? ADMIN_SENSITIVE_DANGER.dot
                              : ADMIN_NEUTRAL_DOT_STYLE,
                          )}
                        />
                      )}
                    </span>
                    <span className="mt-0.5 block text-[13px] font-semibold leading-4 text-white">
                      {notification.title}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-white/65">
                      {notification.body}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] leading-none text-white/42">
                      <span>{formatNotificationDate(notification.eventAt)}</span>
                      {notification.actionLabel && (
                        <span
                          className={cn(
                            "font-black group-hover:text-white",
                            sensitive
                              ? ADMIN_SENSITIVE_DANGER.label
                              : "text-beyonix-sky",
                          )}
                        >
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
