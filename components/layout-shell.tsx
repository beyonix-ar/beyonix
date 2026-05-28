"use client"

import { usePathname } from "next/navigation"

import { SiteHeader } from "@/components/site-header"

import { Footer } from "@/components/footer"

export function LayoutShell({
  children,
}: {
  children: React.ReactNode
}) {
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

  // Admin layout
  if (isAdmin || isPasswordReset) {
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
