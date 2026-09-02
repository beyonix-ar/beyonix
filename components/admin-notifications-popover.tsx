"use client"

import {
  Bell,
  CreditCard,
  FileText,
  MessageCircle,
  PackageSearch,
  ShieldAlert,
  ShoppingCart,
  Truck,
  Undo2,
  XCircle,
} from "lucide-react"

import {
  markAdminNotificationRead,
  type AdminNotification,
  type AdminNotificationType,
} from "@/lib/admin/admin-notifications"
import {
  ADMIN_ATTENTION_WARNING,
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
  mercadolibre_return: "Devolución de Mercado Libre",
  inventory: "Integridad de inventario",
}

const ADMIN_NEUTRAL_CARD_STYLE =
  "admin-ds-notification-card"
const ADMIN_NEUTRAL_ICON_STYLE =
  "admin-ds-notification-icon"
const ADMIN_NEUTRAL_DOT_STYLE = "admin-ds-notification-dot"
// Ver comentario en admin-notification-bell.tsx: variante "storefront" para
// cuando este popover se usa fuera de .beyonix-admin-shell (SiteHeader,
// badge de checkout) -- clases propias themeadas con data-account-theme,
// admin-ds-* queda intacto para el panel admin real.
const STOREFRONT_CARD_STYLE = "beyonix-header-notif-card"
const STOREFRONT_ICON_STYLE = "beyonix-header-notif-icon"
const STOREFRONT_DOT_STYLE = "beyonix-header-notif-dot"
const ADMIN_INCOMING_PAYMENT_STYLE = {
  card: "border-emerald-300/35 bg-emerald-400/[0.07] shadow-[0_0_18px_rgba(52,211,153,0.08)] hover:border-emerald-200/55 hover:bg-emerald-400/[0.12]",
  icon: "border-emerald-300/35 bg-emerald-400/10 text-white",
  label: "text-emerald-200/80",
  dot: "bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.75)]",
} as const

function getNotificationIcon(type: AdminNotificationType) {
  if (type === "order") return ShoppingCart
  if (type === "message") return MessageCircle
  if (type === "payment") return CreditCard
  if (type === "invoice") return FileText
  if (type === "shipping") return Truck
  if (type === "cancellation") return XCircle
  if (type === "claim") return ShieldAlert
  if (type === "mercadolibre_return") return Undo2
  if (type === "inventory") return PackageSearch
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
  variant?: "admin" | "storefront"
}

export function AdminNotificationsPopover({
  notifications,
  loading = false,
  error = "",
  onNotificationClick,
  onRetry,
  variant = "admin",
}: AdminNotificationsPopoverProps) {
  const isStorefront = variant === "storefront"

  return (
    <div
      className={cn(
        isStorefront ? "beyonix-header-notif-panel" : "admin-ds-notification-popover",
        "w-full overflow-hidden font-heading",
      )}
    >
      <div
        className={cn(
          isStorefront ? "beyonix-header-notif-panel-header" : "admin-ds-notification-header",
          "px-4 py-3",
        )}
      >
        <p className={cn("text-sm font-black", isStorefront ? "beyonix-header-notif-title" : "text-white")}>
          {isStorefront ? "Notificaciones" : "Notificaciones admin"}
        </p>
        <p className={cn("mt-0.5 text-10px", isStorefront ? "beyonix-header-notif-muted" : "text-white/50")}>
          {notifications.length > 0
            ? `${notifications.length} pendientes`
            : "Todo está al día"}
        </p>
      </div>

      <div className="admin-ds-notification-scroll custom-scrollbar overflow-y-auto p-2">
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className={cn(
                  isStorefront ? "beyonix-header-notif-card" : "admin-ds-skeleton",
                  "h-24 animate-pulse",
                )}
              />
            ))}
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center">
            <p className={cn("text-sm font-semibold", isStorefront ? "beyonix-header-notif-title" : "text-white")}>
              No pudimos cargar las notificaciones
            </p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className={cn(
                  "mt-3 cursor-pointer text-xs font-semibold",
                  isStorefront
                    ? "text-[var(--account-accent-soft)] hover:text-[var(--beyonix-text-primary)]"
                    : "text-beyonix-sky hover:text-white",
                )}
              >
                Reintentar
              </button>
            )}
          </div>
        ) : notifications.length === 0 ? (
          <div className={cn("text-center", isStorefront ? "px-5 py-6" : "px-5 py-9")}>
            <span
              className={cn(
                "mx-auto flex size-11 items-center justify-center rounded-full border",
                isStorefront ? STOREFRONT_ICON_STYLE : "admin-ds-empty-icon text-white/50",
              )}
            >
              <Bell className="size-5" />
            </span>
            <p className={cn("mt-3 text-sm font-semibold", isStorefront ? "beyonix-header-notif-title" : "text-white")}>
              {isStorefront ? "No tenés notificaciones" : "No hay alertas pendientes"}
            </p>
            {isStorefront && (
              <p className="beyonix-header-notif-muted mt-1 text-xs leading-5">
                Cuando haya novedades aparecerán acá.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            {notifications.map((notification) => {
              const Icon = getNotificationIcon(notification.type)
              const mercadoLibreReturn =
                notification.type === "mercadolibre_return"
              const sensitive = isAdminSensitiveNotification(notification)
              const incomingPayment = notification.eventKey.startsWith("balance-topup:")
              const typeLabel =
                notification.type === "claim" &&
                notification.title.toLowerCase().includes("mensaje de ayuda")
                  ? "Mensaje de ayuda"
                  : TYPE_LABELS[notification.type]
              return (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => onNotificationClick(notification)}
                  className={cn(
                    "group flex w-full cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-left transition-all",
                    mercadoLibreReturn
                      ? ADMIN_ATTENTION_WARNING.card
                      : sensitive
                        ? ADMIN_SENSITIVE_DANGER.card
                        : incomingPayment
                          ? ADMIN_INCOMING_PAYMENT_STYLE.card
                          : isStorefront
                            ? STOREFRONT_CARD_STYLE
                            : ADMIN_NEUTRAL_CARD_STYLE,
                  )}
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg border",
                      mercadoLibreReturn
                        ? ADMIN_ATTENTION_WARNING.icon
                        : sensitive
                          ? ADMIN_SENSITIVE_DANGER.icon
                          : incomingPayment
                            ? ADMIN_INCOMING_PAYMENT_STYLE.icon
                            : isStorefront
                              ? STOREFRONT_ICON_STYLE
                              : ADMIN_NEUTRAL_ICON_STYLE,
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-start gap-2">
                      <span
                        className={cn(
                          "min-w-0 flex-1 text-xs font-bold uppercase tracking-normal leading-4",
                          mercadoLibreReturn
                            ? ADMIN_ATTENTION_WARNING.label
                            : sensitive
                              ? ADMIN_SENSITIVE_DANGER.label
                              : incomingPayment
                                ? ADMIN_INCOMING_PAYMENT_STYLE.label
                                : isStorefront
                                  ? "beyonix-header-notif-muted"
                                  : "text-white/64",
                        )}
                      >
                        {typeLabel}
                      </span>
                      {!notification.isRead && (
                        <span
                          className={cn(
                            "mt-1 size-1.5 shrink-0 rounded-full",
                            mercadoLibreReturn
                              ? ADMIN_ATTENTION_WARNING.dot
                              : sensitive
                                ? ADMIN_SENSITIVE_DANGER.dot
                                : incomingPayment
                                  ? ADMIN_INCOMING_PAYMENT_STYLE.dot
                                  : isStorefront
                                    ? STOREFRONT_DOT_STYLE
                                    : ADMIN_NEUTRAL_DOT_STYLE,
                          )}
                        />
                      )}
                    </span>
                    <span className={cn("mt-0.5 block text-xs font-semibold leading-4", isStorefront ? "beyonix-header-notif-title" : "text-white")}>
                      {notification.title}
                    </span>
                    <span className={cn("mt-0.5 line-clamp-2 block text-11px leading-4", isStorefront ? "beyonix-header-notif-body" : "text-white/65")}>
                      {notification.body}
                    </span>
                    <span className={cn("mt-1 flex flex-wrap items-center gap-2 text-11px leading-none", isStorefront ? "beyonix-header-notif-muted" : "text-white/42")}>
                      <span>{formatNotificationDate(notification.eventAt)}</span>
                      {notification.actionLabel && (
                        <span
                          className={cn(
                            "font-black",
                            isStorefront ? "group-hover:text-[var(--beyonix-text-primary)]" : "group-hover:text-white",
                            mercadoLibreReturn
                              ? ADMIN_ATTENTION_WARNING.label
                              : sensitive
                                ? ADMIN_SENSITIVE_DANGER.label
                                : incomingPayment
                                  ? "text-emerald-300"
                                  : isStorefront
                                    ? "text-[var(--account-accent-soft)]"
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
