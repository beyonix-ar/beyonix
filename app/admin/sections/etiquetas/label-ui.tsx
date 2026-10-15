"use client"

import { useState, type ReactNode } from "react"
import { Check, Minus, Plus } from "lucide-react"

import { AdminGhostButton, AdminSection, adminControlClassName } from "@/app/admin/components/admin-controls"
import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import { parseCopies } from "@/lib/labels/queue"
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

// Sección numerada del flujo (1 Buscar → 2 Cola → 3 Formato → 4 Imprimir).
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

// Cantidad de etiquetas: − / número / +. Lo escrito se aplica sólo si es un
// entero válido (1…max); al salir del campo vuelve al último valor válido.
export function QuantityStepper({ value, max, name, onChange, size = "md" }: {
  value: number
  max: number
  /** Nombre del artículo para las etiquetas accesibles. */
  name: string
  onChange: (value: number) => void
  size?: "sm" | "md"
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const invalid = draft !== null && !parseCopies(draft, max)
  const step = (delta: number) => {
    setDraft(null)
    onChange(Math.min(max, Math.max(1, value + delta)))
  }
  return (
    <div className="inline-flex shrink-0 items-center gap-1">
      <AdminGhostButton size="icon" className={size === "sm" ? "size-8" : "size-9"} aria-label={`Restar una etiqueta de ${name}`} disabled={value <= 1} onClick={() => step(-1)}>
        <Minus className="size-3.5" />
      </AdminGhostButton>
      <input
        type="text"
        inputMode="numeric"
        aria-label={`Cantidad de etiquetas de ${name}`}
        aria-invalid={invalid || undefined}
        title={invalid ? `Entre 1 y ${max}` : "Cantidad de etiquetas"}
        value={draft ?? String(value)}
        className={cn(adminControlClassName, "w-14 px-1 text-center font-black tabular-nums", size === "sm" ? "h-8" : "h-9", invalid && "text-red-300")}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setDraft(null)}
        onChange={(event) => {
          const clean = event.target.value.replace(/\D/g, "").slice(0, 3)
          setDraft(clean)
          const parsed = parseCopies(clean, max)
          if (parsed) onChange(parsed)
        }}
      />
      <AdminGhostButton size="icon" className={size === "sm" ? "size-8" : "size-9"} aria-label={`Sumar una etiqueta de ${name}`} disabled={value >= max} onClick={() => step(1)}>
        <Plus className="size-3.5" />
      </AdminGhostButton>
    </div>
  )
}

export interface LabelStepStatus {
  id: string
  title: string
  status: string
  state: "done" | "current" | "blocked" | "idle"
}

// Resumen del flujo: cada paso muestra su estado y lleva a su sección.
export function LabelStepsBar({ steps }: { steps: readonly LabelStepStatus[] }) {
  return (
    <nav aria-label="Pasos para imprimir etiquetas">
      <ol className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {steps.map((step, index) => (
          <li key={step.id} className="min-w-0">
            <a
              href={`#${step.id}`}
              aria-current={step.state === "current" ? "step" : undefined}
              className={cn(
                "flex h-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 transition hover:bg-white/8",
                step.state === "current" ? "bg-beyonix-blue/20 ring-1 ring-beyonix-sky/45" : "bg-white/4",
              )}
              onClick={(event) => {
                const target = document.getElementById(step.id)
                if (!target) return
                event.preventDefault()
                target.scrollIntoView({ behavior: "smooth", block: "start" })
              }}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-black tabular-nums",
                  step.state === "done" ? "bg-emerald-400/20 text-emerald-300" : step.state === "blocked" ? "bg-amber-400/20 text-amber-300" : step.state === "current" ? "bg-beyonix-sky/25 text-beyonix-cyan" : "bg-white/10 text-white/60",
                )}
                aria-hidden="true"
              >
                {step.state === "done" ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-black text-white">{step.title}</span>
                <span className="block truncate text-11px text-white/55" title={step.status}>{step.status}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}
