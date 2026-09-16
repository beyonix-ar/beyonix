/**
 * Tonos de severidad para notificaciones renderizadas en el scope
 * storefront/cliente (data-account-theme, ver context/account-theme-context.tsx),
 * a diferencia de lib/admin/admin-sensitive-visuals.ts (data-admin-theme,
 * scopeado a .beyonix-admin-shell/.admin-portal-scope).
 *
 * Causa raíz que esto resuelve: components/admin-notification-bell.tsx y
 * components/admin-notifications-popover.tsx reutilizan ADMIN_SENSITIVE_DANGER
 * / ADMIN_ATTENTION_WARNING también en variant="storefront" (campanita del
 * SiteHeader/checkout/public-minimal-header para usuarios staff), pero esas
 * paletas son hex crudos con overrides de Light exclusivos de
 * :is(.beyonix-admin-shell, .admin-portal-scope) -- fuera de ese scope
 * (la tienda pública, en data-account-theme="light") quedan sin ningún
 * override y el fondo se ve oscuro sobre página clara. Acá se usan los
 * mismos tokens --account-danger-x, --account-warning-x y --account-success-x
 * (app/globals.css) que ya están definidos en :root (valor Dark) y
 * reescritos bajo html[data-account-theme="light"][data-account-scope]
 * (mismo mecanismo que .beyonix-stock-badge-danger/-warning/-success) --
 * al referenciarlos con la sintaxis bg-[var(--token)] el color resuelve
 * solo según el theme activo, sin necesitar overrides adicionales acá.
 */

export const ACCOUNT_NOTIFICATION_DANGER = {
  trigger:
    "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger-text)] hover:border-[var(--account-danger)] hover:bg-[var(--account-danger-border)] hover:text-[var(--account-danger-text)]",
  badge: "border-[var(--account-danger)] bg-[var(--account-danger)] text-white",
  card: "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] hover:border-[var(--account-danger)] hover:bg-[var(--account-danger-border)]",
  icon: "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger-text)]",
  dot: "bg-[var(--account-danger)]",
  label: "text-[var(--account-danger-text)]",
} as const

export const ACCOUNT_NOTIFICATION_WARNING = {
  trigger:
    "border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] text-[var(--account-warning-text)] hover:border-[var(--account-warning)] hover:bg-[var(--account-warning-border)] hover:text-[var(--account-warning-text)]",
  badge: "border-[var(--account-warning)] bg-[var(--account-warning)] text-white",
  card: "border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] hover:border-[var(--account-warning)] hover:bg-[var(--account-warning-border)]",
  icon: "border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] text-[var(--account-warning-text)]",
  dot: "bg-[var(--account-warning)]",
  label: "text-[var(--account-warning-text)]",
} as const

export const ACCOUNT_NOTIFICATION_SUCCESS = {
  trigger:
    "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success-text)] hover:border-[var(--account-success)] hover:bg-[var(--account-success-border)] hover:text-[var(--account-success-text)]",
  badge: "border-[var(--account-success)] bg-[var(--account-success)] text-white",
  card: "border-[var(--account-success-border)] bg-[var(--account-success-bg)] hover:border-[var(--account-success)] hover:bg-[var(--account-success-border)]",
  icon: "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success-text)]",
  dot: "bg-[var(--account-success)]",
  label: "text-[var(--account-success-text)]",
} as const

/**
 * Heurística de severidad para customer_notifications (components/
 * customer-notifications-bell.tsx): no existe un campo de prioridad/severidad
 * en la tabla (lib/supabase/types.ts SupabaseCustomerNotification), sólo
 * `type`. Mismo criterio de texto que lib/admin/admin-sensitive-visuals.ts
 * isAdminSensitiveStatus -- clasificación de PRESENTACIÓN únicamente, no
 * toca creación de notificaciones ni estados de la orden.
 */
export function isCustomerNotificationSensitive(type: string) {
  const normalized = type.toLowerCase()

  return (
    normalized === "order_cancelled" ||
    normalized === "refund_pending" ||
    normalized.includes("cancel") ||
    normalized.includes("reject") ||
    normalized.includes("rechaz")
  )
}
