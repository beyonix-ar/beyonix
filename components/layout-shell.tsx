"use client"

import { SiteHeader } from "@/components/site-header"
import { CartWrapper } from "@/components/cart/cart-wrapper"

interface LayoutShellProps {
  children: React.ReactNode
}

export function LayoutShell({ children }: LayoutShellProps) {
  return (
    <>
      <SiteHeader />
      {children}
      <CartWrapper />
    </>
  )
}