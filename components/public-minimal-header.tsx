"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { AccountThemeToggle } from "@/components/account/account-theme-toggle"
import { AdminNotificationsBell } from "@/components/admin-notifications-bell"
import { useAuth } from "@/context/auth-context"
import { useOrderNotifications } from "@/hooks/use-order-notifications"
import { cn } from "@/lib/utils"

/**
 * Header mínimo para flujos públicos "encerrados" (sin el SiteHeader
 * principal ni ningún otro control de tema): "Ir al inicio" a la izquierda,
 * y a la derecha el mismo toggle Claro/Oscuro del resto del sitio
 * (components/account/account-theme-toggle.tsx) seguido -- para
 * staff/admin navegando la tienda -- de la misma campana de notificaciones
 * y en el mismo orden que ya usa app/checkout/page.tsx (toggle size-9,
 * gap-2), así ambos quedan alineados en una sola fila con el mismo lenguaje
 * visual. Reemplaza al badge flotante fixed (antes en
 * components/layout-shell.tsx StandaloneAdminNotifications) que quedaba
 * separado del toggle.
 * No agrega carrito, categorías ni links -- eso es responsabilidad de
 * components/site-header.tsx en el resto del sitio.
 */
export function PublicMinimalHeader({
  homeHref = "/",
  className,
}: {
  homeHref?: string
  className?: string
}) {
  const { isInternal } = useAuth()
  const adminNotifications = useOrderNotifications(isInternal)

  return (
    <header className={cn("flex items-center justify-between py-1", className)}>
      <Link
        href={homeHref}
        aria-label="Ir al inicio"
        title="Ir al inicio"
        className="group -ml-2 inline-flex h-10 items-center gap-2 rounded-xl px-2 text-sm font-semibold text-[var(--account-text-secondary)] transition-colors hover:text-[var(--account-text-primary)]"
      >
        <ArrowLeft
          className="size-4 transition-transform group-hover:-translate-x-0.5"
          aria-hidden="true"
        />
        <span>Ir al inicio</span>
      </Link>
      <div className="flex items-center gap-2">
        <AccountThemeToggle className="size-9" />
        {isInternal && (
          <AdminNotificationsBell
            variant="storefront"
            count={adminNotifications.notificationCount}
            tone={adminNotifications.notificationTone}
            groups={adminNotifications.notificationGroups}
            notifications={adminNotifications.notifications}
            loading={adminNotifications.loading}
            error={adminNotifications.error}
            onRetry={adminNotifications.reloadNotificationCount}
          />
        )}
      </div>
    </header>
  )
}
