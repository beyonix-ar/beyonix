"use client"

import { useEffect, useLayoutEffect } from "react"
import { usePathname } from "next/navigation"

import { SiteHeader } from "@/components/site-header"

import { Footer } from "@/components/footer"
import { CookieConsentAlert } from "@/components/cookie-consent-alert"
import { useClientPresence } from "@/hooks/use-client-presence"
import { useAuth } from "@/context/auth-context"
import { useOrderNotifications } from "@/hooks/use-order-notifications"
import { AdminNotificationsBell } from "@/components/admin-notifications-bell"

function StandaloneAdminNotifications() {
  const { isInternal } = useAuth()
  const notifications = useOrderNotifications(isInternal)

  if (!isInternal) return null

  return (
    <div className="fixed right-4 top-4 z-100">
      <AdminNotificationsBell
        variant="storefront"
        count={notifications.notificationCount}
        tone={notifications.notificationTone}
        groups={notifications.notificationGroups}
        notifications={notifications.notifications}
        loading={notifications.loading}
        error={notifications.error}
        onRetry={notifications.reloadNotificationCount}
      />
    </div>
  )
}

function forceScrollTop() {
  window.scrollTo(0, 0)
  document.documentElement.scrollTop = 0
  document.body.scrollTop = 0
}

export function LayoutShell({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname =
    usePathname()

  useEffect(() => {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual"
    }

    forceScrollTop()
  }, [])

  useLayoutEffect(() => {
    forceScrollTop()

    const frame =
      window.requestAnimationFrame(forceScrollTop)
    const timeout =
      window.setTimeout(forceScrollTop, 80)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
    }
  }, [pathname])

  const isAdmin =
    pathname.startsWith(
      "/admin"
    )

  const isPasswordReset =
    pathname.startsWith(
      "/reset-password"
    )

  const isAuthPage =
    pathname.startsWith(
      "/login"
    )

  const isCheckoutPage =
    pathname.startsWith(
      "/checkout"
    )

  useClientPresence(!isAuthPage && !isPasswordReset)

  // Admin layout
  if (isCheckoutPage) {
    return (
      <>
        {pathname !== "/checkout" && <StandaloneAdminNotifications />}
        {children}
      </>
    )
  }

  // /reset-password se siente parte de BEYONIX desde el primer momento: usa
  // el navbar canónico igual que el resto de la tienda. Sin Footer/cookie
  // banner a propósito -- es una pantalla de una sola tarea (recuperar
  // acceso), no una página de contenido general.
  if (isPasswordReset) {
    return (
      <>
        <SiteHeader />
        {children}
      </>
    )
  }

  if (isAuthPage) {
    return children
  }

  if (isAdmin) {
    return children
  }

  // Store layout
  return (
    <>
      <SiteHeader />

      {children}

      <Footer />

      <CookieConsentAlert />
    </>
  )
}
