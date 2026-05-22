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

  // Admin layout
  if (isAdmin) {
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