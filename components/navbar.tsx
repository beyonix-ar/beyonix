"use client"

import { SiteHeader } from "@/components/site-header"

interface NavbarProps {
  cartItemCount: number
  onCartOpen: () => void
}

export function Navbar(_: NavbarProps) {
  return <SiteHeader />
}