"use client"

import { useEffect, useLayoutEffect } from "react"
import { usePathname } from "next/navigation"

import { SiteHeader } from "@/components/site-header"

import { Footer } from "@/components/footer"
import { CookieConsentAlert } from "@/components/cookie-consent-alert"
import { useClientPresence } from "@/hooks/use-client-presence"

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
    ) ||
    pathname.startsWith(
      "/recuperar-contrasena"
    )

  const isAuthPage =
    pathname.startsWith(
      "/login"
    )

  const isCheckoutPage =
    pathname.startsWith(
      "/checkout"
    )

  // Página del cadete (QR de Envío BEYONIX): una sola tarea, sin menú,
  // header, footer ni banners, y sin presencia de cliente.
  const isCourierPage =
    pathname.startsWith(
      "/delivery/"
    )

  useClientPresence(!isAuthPage && !isPasswordReset && !isCourierPage)

  // Checkout layout: cada página de /checkout* maneja su propio header
  // (incluida la campana de notificaciones para staff/admin) -- /checkout
  // en su propio header inline, success/failure/pending vía
  // components/public-minimal-header.tsx.
  if (isCheckoutPage) {
    return children
  }

  // /reset-password y /recuperar-contrasena se sienten parte de BEYONIX desde el primer momento: usa
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

  if (isCourierPage) {
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
