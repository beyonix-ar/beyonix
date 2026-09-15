"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { AccountThemeToggle } from "@/components/account/account-theme-toggle"
import { cn } from "@/lib/utils"

/**
 * Header mínimo para flujos públicos "encerrados" (sin el SiteHeader
 * principal ni ningún otro control de tema): sólo "Ir al inicio" + el mismo
 * toggle Claro/Oscuro del resto del sitio (components/account/account-theme-toggle.tsx).
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
      <AccountThemeToggle className="size-10" />
    </header>
  )
}
