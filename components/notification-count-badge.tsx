import { formatNotificationBadgeCount } from "@/lib/notifications/notification-badge"
import { cn } from "@/lib/utils"

interface NotificationCountBadgeProps {
  count: number
  // Sólo colores: tamaño y posición son comunes a todas las campanas.
  className?: string
}

export function NotificationCountBadge({ count, className }: NotificationCountBadgeProps) {
  const label = formatNotificationBadgeCount(count)
  if (!label) return null

  return (
    <span
      aria-hidden="true"
      data-notification-badge
      className={cn(
        "pointer-events-none absolute -right-1.5 -top-1.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none tracking-normal tabular-nums",
        className,
      )}
    >
      {label}
    </span>
  )
}
