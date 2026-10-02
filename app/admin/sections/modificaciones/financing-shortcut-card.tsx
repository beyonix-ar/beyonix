"use client"

import Link from "next/link"
import { ArrowRight, CreditCard } from "lucide-react"

import { ADMIN_ROUTES } from "@/lib/admin/admin-routes"
import type { MercadoPagoCostsOverview } from "@/lib/site-settings"
import { ConfigSection, ConfigValueList, ConfigValueRow } from "./config-ui"

/**
 * Configuración sólo resume y deriva: los controles de costos, cuotas y
 * automatización viven en Admin → Financiación (sin duplicarlos acá).
 */
export function FinancingShortcutCard({ overview }: { overview: MercadoPagoCostsOverview | null }) {
  const manual = overview?.mode === "manual"
  const enabled = overview?.interestFreePolicy.enabled

  return (
    <ConfigSection
      icon={<CreditCard className="size-3.5" />}
      title="Financiación Mercado Pago"
      data-config-block="financing"
      actions={
        <Link
          href={ADMIN_ROUTES.financiacion}
          data-financing-shortcut
          className="admin-config-link inline-flex items-center gap-1 rounded-md text-12px font-black underline-offset-2 hover:underline"
        >
          Ir a Financiación
          <ArrowRight className="size-3.5" />
        </Link>
      }
    >
      <ConfigValueList>
        <ConfigValueRow
          label="Modo"
          tone={!overview ? "neutral" : manual ? "warning" : "success"}
          data-financing-mode={overview?.mode ?? "loading"}
        >
          {!overview ? "Consultando…" : manual ? "Manual" : "Automático"}
        </ConfigValueRow>
        <ConfigValueRow
          label="Cuotas sin interés"
          tone={enabled === undefined ? "neutral" : enabled ? "success" : "neutral"}
          data-financing-installments={enabled === undefined ? "loading" : enabled ? "active" : "inactive"}
        >
          {enabled === undefined ? "Consultando…" : enabled ? "Activas" : "Inactivas"}
        </ConfigValueRow>
      </ConfigValueList>
    </ConfigSection>
  )
}
