"use client"

import { useState } from "react"
import { Check, Clock3, Copy, Download, ExternalLink, Package, X } from "lucide-react"

import { ANDREANI_PUBLIC_TRACKING_PAGE_URL } from "@/lib/andreani/public-tracking"
import type {
  CustomerClaimHistoryStep,
  CustomerClaimSummary,
  CustomerClaimSummaryTone,
} from "@/lib/orders/customer-claim-experience"

// El estado nunca depende sólo del color: cada tono tiene ícono y texto propios.
const TONES: Record<CustomerClaimSummaryTone, { label: string; icon: typeof Check; badge: string; circle: string }> = {
  progress: {
    label: "En curso",
    icon: Clock3,
    badge: "border-[var(--account-info-border)] bg-[var(--account-info-bg)] text-[var(--account-info-text)]",
    circle: "border-[var(--account-info-border)] bg-[var(--account-info-bg)] text-[var(--account-info-text)]",
  },
  action: {
    label: "Tenés que hacer algo",
    icon: Package,
    badge: "border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] text-[var(--account-warning-text)]",
    circle: "border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] text-[var(--account-warning-text)]",
  },
  done: {
    label: "Listo",
    icon: Check,
    badge: "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success-text)]",
    circle: "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success-text)]",
  },
  rejected: {
    label: "No aprobado",
    icon: X,
    badge: "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger-text)]",
    circle: "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger-text)]",
  },
}

const ACTION_BUTTON =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border px-5 text-sm font-black transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--account-focus-ring)]"

function TrackingNumber({ tracking }: { tracking: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--account-text-secondary)]">
      <span>Número de envío:</span>
      <span className="font-bold tabular-nums text-[var(--account-text-primary)]">{tracking}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(tracking).then(() => setCopied(true), () => setCopied(false))
        }}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-bold text-[var(--account-text-secondary)] underline underline-offset-2 hover:text-[var(--account-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--account-focus-ring)]"
      >
        <Copy className="size-3.5" aria-hidden="true" />
        {copied ? "Copiado" : "Copiar"}
      </button>
    </p>
  )
}

/** Estado actual del reclamo: qué pasa, qué hacer y qué esperar. */
export function CustomerClaimStatusCard({
  summary,
  returnLabelUrl,
}: {
  summary: CustomerClaimSummary
  returnLabelUrl: string
}) {
  const tone = TONES[summary.tone]
  const Icon = tone.icon

  return (
    <section
      data-testid="customer-claim-status"
      data-tone={summary.tone}
      aria-live="polite"
      className="border-b border-[var(--account-border-subtle)] px-5 py-5"
    >
      <div className="flex items-start gap-3.5">
        <span className={`flex size-11 shrink-0 items-center justify-center rounded-full border ${tone.circle}`}>
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-black ${tone.badge}`}>
            {tone.label}
          </span>
          <h3 className="mt-1.5 text-xl font-black leading-7 text-[var(--account-text-primary)] sm:text-2xl sm:leading-8">
            {summary.title}
          </h3>
          {summary.lines.length > 0 && (
            <div className="mt-1.5 space-y-1 text-base leading-6 text-[var(--account-text-primary)]">
              {summary.lines.map((line) => <p key={line} className="whitespace-pre-wrap">{line}</p>)}
            </div>
          )}
          {summary.branch && (
            <p className="mt-2 text-base leading-6 text-[var(--account-text-primary)]">
              <span className="font-black">Sucursal:</span> {summary.branch}
            </p>
          )}
          {(summary.returnLabel || summary.tracking) && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {summary.returnLabel && (
                <a
                  href={returnLabelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${ACTION_BUTTON} border-[var(--account-border-highlight)] bg-[var(--account-accent)] text-white hover:bg-[var(--account-accent-hover)]`}
                >
                  <Download className="size-4" aria-hidden="true" />
                  Descargar etiqueta
                </a>
              )}
              {summary.tracking && (
                <a
                  href={ANDREANI_PUBLIC_TRACKING_PAGE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${ACTION_BUTTON} border-[var(--account-border)] bg-[var(--account-surface-raised)] text-[var(--account-text-primary)] hover:bg-[var(--account-surface-hover)]`}
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                  Ver seguimiento
                </a>
              )}
            </div>
          )}
          {summary.tracking && <div className="mt-2"><TrackingNumber tracking={summary.tracking} /></div>}
        </div>
      </div>
    </section>
  )
}

/** Hitos ya cumplidos; cerrado por defecto. */
export function CustomerClaimHistory({ steps }: { steps: CustomerClaimHistoryStep[] }) {
  if (steps.length === 0) return null

  return (
    <details data-testid="customer-claim-history" className="group border-b border-[var(--account-border-subtle)] px-5 py-2">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-black text-[var(--account-text-primary)] underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--account-focus-ring)]">
        Ver historial del reclamo
      </summary>
      <ol className="mb-2 mt-1 space-y-2">
        {steps.map((step) => (
          <li key={step.milestone} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-sm text-[var(--account-text-primary)]">
            <Check className="size-4 shrink-0 text-[var(--account-success)]" aria-hidden="true" />
            <span className="font-bold">{step.label}</span>
            {step.date && <span className="text-xs text-[var(--account-text-secondary)]">{step.date}</span>}
          </li>
        ))}
      </ol>
    </details>
  )
}
