"use client"

import { AdminHelpTip } from "../../components/admin-help-tip"

export function DashboardSectionHeader({
  id,
  eyebrow,
  title,
  help,
  description,
  action,
}: {
  id?: string
  eyebrow?: string
  title: string
  help?: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="mb-0.5 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">{eyebrow}</p>}
        <h2 id={id} className="flex items-center gap-1.5 text-lg font-black text-white">
          {title}
          {help && <AdminHelpTip label={title} text={help} />}
        </h2>
        {description && <p className="mt-0.5 text-xs text-white/52">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function FinancialMetric({
  label,
  value,
  detail,
  help,
  tone = "neutral",
}: {
  label: string
  value: string
  detail: string
  help?: string
  tone?: "neutral" | "positive" | "warning" | "danger"
}) {
  const toneClass = {
    neutral: "text-white",
    positive: "text-emerald-300",
    warning: "text-amber-200",
    danger: "text-red-300",
  }[tone]

  return (
    <div className="admin-dashboard-financial-metric min-w-0 rounded-xl border px-3 py-2.5">
      <p className="flex items-center gap-1 text-10px font-black uppercase tracking-widest text-white/52">
        <span className="min-w-0 leading-tight">{label}</span>
        {help && <AdminHelpTip label={label} text={help} />}
      </p>
      <p className={`mt-1 truncate text-base font-black tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-0.5 line-clamp-2 text-11px font-semibold text-white/45">{detail}</p>
    </div>
  )
}
