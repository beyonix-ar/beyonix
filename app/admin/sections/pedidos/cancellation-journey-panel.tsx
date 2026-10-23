"use client"

import { ArrowRight, Check, CheckCircle2 } from "lucide-react"

import { getCancellationJourney, type CancellationJourneyOrder } from "@/lib/orders/cancellation-journey"

const DONE = new Set(["done", "not_required"])

/**
 * Asistente de la cancelación. En la pestaña Cancelación muestra los seis
 * pasos y el siguiente; en el resto, una sola línea que lleva hasta ahí. El
 * progreso sale del pedido persistido: volver o recargar no lo pierde.
 */
export function CancellationJourneyPanel({ pedido, compact, onOpen }: {
  pedido: CancellationJourneyOrder
  compact: boolean
  onOpen: () => void
}) {
  const journey = getCancellationJourney(pedido)
  if (!journey) return null
  const focus = journey.steps.find((step) => step.key === journey.current)
    ?? journey.steps.find((step) => step.status === "processing" || step.status === "waiting")
  const stepNumber = focus ? journey.steps.indexOf(focus) + 1 : journey.steps.length

  if (compact) {
    return (
      <section aria-label="Cancelación en curso" data-testid="cancellation-journey-compact"
        className="admin-order-cancellation-panel my-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2">
        <p className="min-w-0 text-xs font-bold text-[var(--admin-text)]">
          {journey.finished ? "✓ Cancelación completada" : `Cancelación · Paso ${stepNumber} de ${journey.steps.length}: ${focus?.label ?? ""}`}
        </p>
        {!journey.finished && (
          <button type="button" onClick={onOpen} className="admin-ds-button admin-ds-button-secondary inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 px-3 text-11px font-black uppercase tracking-wide">
            Continuar cancelación <ArrowRight className="size-3.5" />
          </button>
        )}
      </section>
    )
  }

  return (
    <section aria-label="Asistente de cancelación" data-testid="cancellation-journey" data-current-step={journey.current ?? (journey.finished ? "finished" : "waiting")}
      className="admin-order-cancellation-panel admin-financial-wizard mb-3 rounded-xl border p-3">
      <p className="text-11px font-bold uppercase tracking-widest text-[var(--admin-text-muted)]">Asistente de cancelación</p>
      <ol className="admin-financial-wizard-steps mt-2" aria-label="Pasos de la cancelación">
        {journey.steps.map((step, index) => {
          const done = DONE.has(step.status)
          return (
            <li key={step.key} data-step={step.key} data-status={step.status} aria-current={step === focus ? "step" : undefined}
              className={step === focus ? "is-current" : done ? "is-done" : ""}>
              <span className="admin-financial-wizard-step-number">{done ? <Check className="size-3" aria-hidden="true" /> : index + 1}</span>
              {step.label}
            </li>
          )
        })}
      </ol>

      {journey.finished ? (
        <ul className="mt-3 grid gap-1 text-sm font-bold text-[var(--admin-success-text)]" aria-label="Resumen de la cancelación">
          {journey.steps.filter((step) => step.key !== "finished" && step.status === "done").map((step) => (
            <li key={step.key} className="flex items-center gap-2"><CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />{step.detail}</li>
          ))}
          <li className="flex items-center gap-2"><CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />Cancelación completada</li>
        </ul>
      ) : focus && (
        <div className="admin-financial-wizard-body mt-3 grid gap-2" data-step={focus.key}>
          <p className="text-sm font-black text-[var(--admin-text)]">Paso {stepNumber} — {focus.label}</p>
          <p className="text-xs font-semibold text-[var(--admin-text-soft)]">{focus.detail}</p>
          {journey.action && focus.key === "merchandise" && (
            <div>
              <a href={journey.action.href} className="admin-ds-button admin-ds-button-primary inline-flex h-9 items-center justify-center gap-2 px-3.5 text-11px font-black uppercase tracking-wide">
                {journey.action.label} <ArrowRight className="size-3.5" />
              </a>
            </div>
          )}
          {["money", "refund"].includes(focus.key) && focus.status !== "waiting" && (
            <p className="text-xs font-semibold text-[var(--admin-text-muted)]">Continuá abajo, en esta misma pantalla.</p>
          )}
        </div>
      )}
    </section>
  )
}
