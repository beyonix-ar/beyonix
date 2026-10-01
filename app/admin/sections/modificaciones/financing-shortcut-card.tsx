"use client"

import Link from "next/link"
import { ArrowRight, CreditCard } from "lucide-react"

import { ADMIN_ROUTES } from "@/lib/admin/admin-routes"
import type { MercadoPagoCostsOverview } from "@/lib/site-settings"
import { ConfigSection } from "./config-ui"

/**
 * Configuración sólo resume y deriva: los controles de costos, cuotas y
 * automatización viven en Admin → Financiación (sin duplicarlos acá).
 */
export function FinancingShortcutCard({ overview }: { overview: MercadoPagoCostsOverview | null }) {
  const summary = overview
    ? [
        overview.mode === "automatic" ? "Modo automático" : "Modo manual",
        overview.interestFreePolicy.enabled ? "cuotas sin interés activas" : "cuotas sin interés inactivas",
      ].join(" · ")
    : null

  return (
    <ConfigSection
      icon={<CreditCard className="size-3.5" />}
      eyebrow="Pagos"
      title="Financiación Mercado Pago"
      description="Gestionar costos, cuotas y automatización."
      actions={
        <Link
          href={ADMIN_ROUTES.financiacion}
          data-financing-shortcut
          className="inline-flex items-center gap-1.5 text-12px font-black text-beyonix-sky underline-offset-2 hover:underline"
        >
          Ir a Financiación
          <ArrowRight className="size-3.5" />
        </Link>
      }
    >
      {summary ? <p className="text-12px font-semibold text-white/70">{summary}</p> : null}
    </ConfigSection>
  )
}
