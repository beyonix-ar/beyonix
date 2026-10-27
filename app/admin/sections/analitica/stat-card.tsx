"use client"

import type { ReactNode } from "react"

import { AdminHelpTip } from "../../components/admin-help-tip"

interface AnalyticsStatCardProps {
  /** Clases propias (identificación y spans de la grilla). */
  className: string
  label: string
  help?: string
  /** Valor ya formateado; `null` mientras no hay reporte del período. */
  value: string | null
  detail: string
  loadError: string | null
  /** Línea de variación contra el período anterior. */
  change?: ReactNode
}

/**
 * Card de métrica de Analítica con estados de carga ("…") y error ("—" y el
 * mensaje) mientras no hay dato del período mostrado.
 */
export function AnalyticsStatCard({ className, label, help, value, detail, loadError, change }: AnalyticsStatCardProps) {
  return (
    <div className={`admin-dashboard-kpi ${className} min-w-0 rounded-2xl border px-4 py-3`} aria-busy={value === null && !loadError}>
      <p className="flex items-center gap-1 text-10px font-black uppercase tracking-widest text-white/52">
        {label}
        {help && <AdminHelpTip label={label} text={help} />}
      </p>
      <p className="mt-1 truncate text-2xl font-black tabular-nums text-white">{value ?? (loadError ? "—" : "…")}</p>
      <p className="mt-0.5 truncate text-11px text-white/52">{value === null && loadError ? loadError : detail}</p>
      {value !== null && change}
    </div>
  )
}
