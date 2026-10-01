"use client"

import type { ReactNode } from "react"
import { CheckCircle2, Save, ShieldAlert } from "lucide-react"

import { cn } from "@/lib/utils"
import { AdminPrimaryButton, AdminSection } from "../../components/admin-controls"

export type ConfigTone = "neutral" | "info" | "success" | "warning" | "danger"

export interface ConfigFeedback {
  tone: "success" | "danger"
  text: string
}

interface ConfigSaveActionsProps {
  dirty: boolean
  saving: boolean
  disabled: boolean
  onSave: () => void
}

/** Guardado por bloque: sólo se habilita con cambios propios del bloque. */
export function ConfigSaveActions({ dirty, saving, disabled, onSave }: ConfigSaveActionsProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="admin-config-dirty text-11px font-bold" data-dirty={dirty ? "true" : "false"}>
        {dirty ? "Cambios sin guardar" : "Sin cambios"}
      </span>
      <AdminPrimaryButton
        type="button"
        size="sm"
        onClick={onSave}
        disabled={disabled || saving || !dirty}
        className="shrink-0"
      >
        <Save className="size-3.5" />
        {saving ? "Guardando…" : "Guardar cambios"}
      </AdminPrimaryButton>
    </div>
  )
}

interface ConfigSectionProps {
  icon: ReactNode
  eyebrow: string
  title: string
  description: string
  actions?: ReactNode
  feedback?: ConfigFeedback | null
  className?: string
  children: ReactNode
}

export function ConfigSection({
  icon,
  eyebrow,
  title,
  description,
  actions,
  feedback,
  className,
  children,
}: ConfigSectionProps) {
  return (
    <AdminSection
      compact
      icon={icon}
      eyebrow={eyebrow}
      title={title}
      description={description}
      actions={actions}
      className={cn("admin-config-section", className)}
    >
      {children}
      {feedback ? (
        <p
          role={feedback.tone === "danger" ? "alert" : "status"}
          className={cn(
            "mt-3 flex items-center gap-1.5 text-12px font-semibold",
            feedback.tone === "success" ? "text-emerald-200" : "text-red-200",
          )}
        >
          {feedback.tone === "success" ? (
            <CheckCircle2 className="size-3.5 shrink-0" />
          ) : (
            <ShieldAlert className="size-3.5 shrink-0" />
          )}
          {feedback.text}
        </p>
      ) : null}
    </AdminSection>
  )
}

interface ConfigTileProps {
  label: string
  value: ReactNode
  tone?: ConfigTone
  detail?: ReactNode
  action?: ReactNode
  className?: string
}

/** Mini tarjeta de estado: etiqueta chica, valor con punto de color y detalle opcional. */
export function ConfigTile({ label, value, tone = "neutral", detail, action, className }: ConfigTileProps) {
  return (
    <div className={cn("admin-config-tile flex min-w-0 flex-col gap-1 px-3 py-2.5", className)} data-tone={tone}>
      <p className="text-10px font-black uppercase tracking-widest text-white/55">{label}</p>
      <p className="flex min-w-0 items-center gap-1.5 text-sm font-black text-white">
        <span className="admin-config-dot size-1.5 shrink-0 rounded-full" data-tone={tone} />
        <span className="truncate">{value}</span>
      </p>
      {detail ? <p className="text-12px leading-4 text-white/62">{detail}</p> : null}
      {action ? <div className="mt-auto pt-1">{action}</div> : null}
    </div>
  )
}

/** Recuadro destacado para el resumen de una regla (envíos, ejemplos de precio). */
export function ConfigSummary({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("admin-config-summary px-3.5 py-3 text-12px leading-5 text-white/74", className)}>
      {children}
    </div>
  )
}

export function sanitizePercentInput(value: string) {
  return value.replace(/[^0-9,.]/g, "")
}

export function sanitizeAmountInput(value: string) {
  return value.replace(/\D/g, "")
}

export function withInputSymbol(value: string, symbol: "$" | "%") {
  return value ? `${symbol} ${value}` : ""
}

export function parseAmount(value: string) {
  const amount = Number.parseInt(value.replace(/[^\d]/g, ""), 10)
  return Number.isFinite(amount) && amount >= 0 ? amount : 0
}

export function parsePercentage(value: string) {
  const percentage = Number(value.replace(",", "."))
  return Number.isFinite(percentage)
    ? Math.min(100, Math.max(0, Math.round(percentage * 100) / 100))
    : 0
}

export const formatARS = (value: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value)

export const formatPercent = (value: number, maximumFractionDigits = 2) =>
  `${new Intl.NumberFormat("es-AR", { maximumFractionDigits }).format(value)}%`

export const formatDateTime = (value: string) =>
  new Date(value).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
