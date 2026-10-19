"use client"

import { type ReactNode } from "react"

import { AdminSection } from "@/app/admin/components/admin-controls"
import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import { cn } from "@/lib/utils"

export const LABEL_STEP_IDS = {
  search: "etiquetas-paso-buscar",
  queue: "etiquetas-paso-cola",
  format: "etiquetas-paso-formato",
  output: "etiquetas-paso-imprimir",
} as const

export function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count.toLocaleString("es-AR")} ${count === 1 ? singular : pluralForm}`
}

// Sección compartida por las vistas de configuración y previsualización.
export function LabelStepSection({ id, step, title, description, actions, className, children }: {
  id: string
  step: number
  title: string
  description?: string
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <AdminSection
      id={id}
      icon={<span className="text-sm font-black tabular-nums" aria-hidden="true">{step}</span>}
      eyebrow={`Paso ${step}`}
      title={title}
      description={description}
      actions={actions}
      className={cn("@container min-w-0 scroll-mt-6", className)}
    >
      {children}
    </AdminSection>
  )
}

export function FieldLabel({ children, help, helpLabel, htmlFor }: { children: ReactNode; help?: string; helpLabel?: string; htmlFor?: string }) {
  return (
    <span className="mb-1.5 flex items-center gap-1 text-xs font-black text-white/80">
      {htmlFor ? <label htmlFor={htmlFor}>{children}</label> : children}
      {help && <AdminHelpTip label={helpLabel ?? String(children)} text={help} />}
    </span>
  )
}

export function StatTile({ label, value, hint, tone = "default" }: { label: string; value: ReactNode; hint?: string; tone?: "default" | "accent" | "muted" }) {
  return (
    <div className="min-w-0 rounded-xl bg-white/5 px-3 py-2.5">
      <p className="truncate text-10px font-black uppercase tracking-widest text-white/50">{label}</p>
      <p className={cn("mt-0.5 truncate text-lg font-black leading-tight tabular-nums", tone === "accent" ? "text-beyonix-cyan" : tone === "muted" ? "text-white/60" : "text-white")}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-11px text-white/50" title={hint}>{hint}</p>}
    </div>
  )
}
