"use client"

import { usePathname } from "next/navigation"

import { SiteHeader } from "@/components/site-header"

import { Footer } from "@/components/footer"
import { useClientPresence } from "@/hooks/use-client-presence"

export function LayoutShell({
  children,
}: {
  children: React.ReactNode
}) {
  useClientPresence()

  const pathname =
    usePathname()

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

  // Admin layout
  if (isAdmin || isPasswordReset || isAuthPage) {
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
