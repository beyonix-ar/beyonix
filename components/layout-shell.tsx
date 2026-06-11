"use client"

import { useEffect, useLayoutEffect } from "react"
import { usePathname } from "next/navigation"

import { SiteHeader } from "@/components/site-header"

import { Footer } from "@/components/footer"
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
  useClientPresence()

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

  // Admin layout
  if (isAdmin || isPasswordReset || isAuthPage || isCheckoutPage) {
    return children
  }

  // Store layout
  return (
    <>
      <SiteHeader />

      {children}

      <Footer />
    </>
  )
}
