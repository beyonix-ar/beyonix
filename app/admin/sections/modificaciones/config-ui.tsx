"use client"

import type { ReactNode } from "react"
import { CheckCircle2, ChevronRight, Save, ShieldAlert } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  AdminPrimaryButton,
  AdminSecondaryButton,
  adminCardClassName,
  adminSurfaceLevel,
} from "../../components/admin-controls"

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

/**
 * Guardado por bloque: sólo se habilita con cambios propios del bloque. Sin
 * cambios queda discreto (botón secundario); con cambios pasa a primario.
 */
export function ConfigSaveActions({ dirty, saving, disabled, onSave }: ConfigSaveActionsProps) {
  const Button = dirty ? AdminPrimaryButton : AdminSecondaryButton
  return (
    <div className="flex items-center gap-2">
      <span className="admin-config-dirty text-11px font-bold" data-dirty={dirty ? "true" : "false"}>
        {dirty ? "Cambios sin guardar" : "Sin cambios"}
      </span>
      <Button
        type="button"
        size="sm"
        onClick={onSave}
        disabled={disabled || saving || !dirty}
        className="admin-config-save shrink-0"
      >
        <Save className="size-3.5" />
        {saving ? "Guardando…" : "Guardar cambios"}
      </Button>
    </div>
  )
}

interface ConfigSectionProps {
  icon?: ReactNode
  title: string
  /** Estado corto junto al título (chip o texto), nunca un párrafo. */
  summary?: ReactNode
  description?: string
  actions?: ReactNode
  feedback?: ConfigFeedback | null
  className?: string
  children: ReactNode
  [dataAttribute: `data-${string}`]: string | undefined
}

/**
 * Tarjeta de un bloque de configuración: título compacto con su estado y
 * acciones a la derecha; el contenido sin cajas anidadas.
 */
export function ConfigSection({
  icon,
  title,
  summary,
  description,
  actions,
  feedback,
  className,
  children,
  ...rest
}: ConfigSectionProps) {
  return (
    <section
      className={cn(adminCardClassName, adminSurfaceLevel.section, "admin-config-section min-w-0 p-3.5", className)}
      {...rest}
    >
      <header className="mb-2.5 flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {icon ? <span className="admin-config-icon flex shrink-0 items-center">{icon}</span> : null}
            <h3 className="text-sm font-black leading-tight text-white">{title}</h3>
            {summary}
          </div>
          {description ? <p className="mt-0.5 text-12px leading-4 text-white/62">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
      {feedback ? (
        <p
          role={feedback.tone === "danger" ? "alert" : "status"}
          className="admin-config-feedback mt-2.5 flex items-center gap-1.5 text-12px font-semibold"
          data-tone={feedback.tone}
        >
          {feedback.tone === "success" ? (
            <CheckCircle2 className="size-3.5 shrink-0" />
          ) : (
            <ShieldAlert className="size-3.5 shrink-0" />
          )}
          {feedback.text}
        </p>
      ) : null}
    </section>
  )
}

/** Agrupación de bloques por categoría (Integraciones, Inventario, …). */
export function ConfigGroup({
  id,
  label,
  className,
  children,
}: {
  id: string
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <section aria-labelledby={`config-group-${id}`} data-config-group={id} className={cn("min-w-0 space-y-2", className)}>
      <h2 id={`config-group-${id}`} className="admin-config-group-title px-0.5 text-11px font-black uppercase tracking-widest">
        {label}
      </h2>
      <div className="grid gap-3">{children}</div>
    </section>
  )
}

/** Fila de datos "etiqueta: valor" sin cajas, para estados de un vistazo. */
export function ConfigStats({ className, children }: { className?: string; children: ReactNode }) {
  return <dl className={cn("grid gap-x-4 gap-y-2.5", className)}>{children}</dl>
}

export function ConfigStat({
  label,
  value,
  tone,
  detail,
  className,
  ...rest
}: {
  label: string
  value: ReactNode
  tone?: ConfigTone
  detail?: ReactNode
  className?: string
  [dataAttribute: `data-${string}`]: string | undefined
}) {
  return (
    <div className={cn("min-w-0", className)} {...rest}>
      <dt className="text-11px font-bold text-white/62">{label}</dt>
      <dd className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm font-black text-white">
        {tone ? <span className="admin-config-dot size-2 shrink-0 rounded-full" data-tone={tone} /> : null}
        <span className="min-w-0 truncate">{value}</span>
      </dd>
      {detail ? <dd className="mt-0.5 text-12px leading-4 text-white/62">{detail}</dd> : null}
    </div>
  )
}

/** "Lo técnico se despliega": detalle colapsado por defecto. */
export function ConfigDisclosure({
  summary,
  className,
  children,
  ...rest
}: {
  summary: string
  className?: string
  children: ReactNode
  [dataAttribute: `data-${string}`]: string | undefined
}) {
  return (
    <details className={cn("admin-config-details group text-12px leading-5 text-white/72", className)} {...rest}>
      <summary className="flex cursor-pointer items-center gap-1 font-bold text-white/80">
        <ChevronRight className="admin-config-details-icon size-3.5 shrink-0 transition-transform" aria-hidden="true" />
        {summary}
      </summary>
      <div className="mt-1.5 space-y-1 pl-4.5">{children}</div>
    </details>
  )
}

/** Chip discreto de estado. */
export function ConfigChip({
  tone = "neutral",
  className,
  children,
  ...rest
}: {
  tone?: ConfigTone
  className?: string
  children: ReactNode
  [dataAttribute: `data-${string}`]: string | undefined
}) {
  return (
    <span className={cn("admin-config-chip text-11px font-bold", className)} data-tone={tone} {...rest}>
      {children}
    </span>
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
