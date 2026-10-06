"use client"

import { useCallback, useEffect, useReducer, useState } from "react"
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, Download, Eye, LoaderCircle, RefreshCw } from "lucide-react"
import { supabase } from "@/lib/supabase/client"
import {
  buildFinancialResolvePayload, canContinueFinancialWizard, EXCEPTION_REASON_MIN_LENGTH, FINANCIAL_CHOICE_COPY,
  FINANCIAL_PRODUCT_COPY, FINANCIAL_STEP_LABELS, getFinancialHumanState, getFinancialMoneyOptions, getFinancialOutcome,
  getFinancialReceptionLabel, getFinancialWizardSteps, initialFinancialWizardState, isProductOptionAvailable,
  reduceFinancialWizard, type FinancialResolutionView, type FinancialWizardAction, type FinancialWizardState,
} from "@/lib/orders/financial-resolution-wizard"
import type { SupabasePedido } from "@/lib/supabase/types"
import { AdminButton, AdminModal, AdminTextarea, AdminTextInput } from "../../components/admin-controls"
import { formatPrice } from "../productos/helpers"

const MODES = ["wizard", "resolution", "advanced", "none"]
const PROOF_ACCEPT = "image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf"

async function financialRequest(orderId: number, init?: RequestInit) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("La sesión administrativa venció.")
  const response = await fetch(`/api/admin/orders/${orderId}/financial-resolution`, {
    ...init, headers: { ...init?.headers, Authorization: `Bearer ${session.access_token}` },
  })
  const data = (await response.json().catch(() => ({}))) as { error?: string } & Partial<FinancialResolutionView>
  if (!response.ok && response.status !== 202) throw new Error(data.error || "No se pudo continuar. Revisá el pedido e intentá nuevamente.")
  return data
}

/** Consulta la API de Etapa 5. Un fallo deja el flujo existente como respaldo. */
export function useFinancialResolutionView(orderId: number, enabled: boolean, revision: string) {
  const [result, setResult] = useState<{ key: string; view: FinancialResolutionView | null } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const key = `${orderId}:${revision}:${reloadToken}`

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    financialRequest(orderId)
      .then((data) => {
        if (!cancelled) setResult({ key, view: MODES.includes(data.mode ?? "") ? data as FinancialResolutionView : null })
      })
      .catch(() => { if (!cancelled) setResult({ key, view: null }) })
    return () => { cancelled = true }
  }, [enabled, orderId, key])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  // Mientras se actualiza se conserva la vista del mismo pedido: sin parpadeo.
  const current = result?.key.startsWith(`${orderId}:`) ? result : null
  return { view: current?.view ?? null, loading: enabled && !current, reload }
}

type WizardProps = {
  pedido: SupabasePedido
  view: FinancialResolutionView
  orderNumber: string
  customerName: string
  reason: string | null
  onChanged: () => void
  onOpenBilling: () => void
  onOpenAttention: () => void
  onDownloadCreditNote: (noteId: string) => void
}

export function FinancialResolutionWizard(props: WizardProps) {
  const humanState = getFinancialHumanState(props.view)
  return (
    <section
      className="admin-order-cancellation-panel admin-financial-wizard rounded-xl border p-3"
      data-testid="financial-resolution"
      data-financial-state={humanState}
      data-requires-action={humanState === "Requiere acción" ? "true" : "false"}
    >
      <header className="admin-order-cancellation-header flex flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div className="min-w-0">
          <p className="text-11px font-bold uppercase tracking-widest text-[var(--admin-text-muted)]">Resolución · {props.orderNumber}</p>
          <h3 className="mt-1 text-base font-black text-[var(--admin-text)]">
            {props.view.resolution ? FINANCIAL_CHOICE_COPY[props.view.resolution.type].label : "Cancelación / reintegro"}
          </h3>
        </div>
        <p className="admin-financial-wizard-amount text-lg font-black">{formatPrice(props.view.resolution?.amount ?? props.view.amount)}</p>
      </header>
      {props.view.resolution ? <FinancialResolutionOutcome {...props} /> : <FinancialWizardFlow {...props} />}
    </section>
  )
}

function OptionCard({ selected, disabled, title, description, onSelect }: {
  selected: boolean; disabled?: boolean; title: string; description: string; onSelect: () => void
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect}
      className={`admin-financial-wizard-option ${selected ? "is-selected" : ""}`}>
      <span className="admin-financial-wizard-option-title">
        {selected && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
        {title}
      </span>
      <span className="admin-financial-wizard-option-description">{description}</span>
    </button>
  )
}

function FinancialWizardFlow({ view, orderNumber, customerName, reason, onChanged, onOpenAttention, pedido }: WizardProps) {
  const [state, dispatch] = useReducer(
    (current: FinancialWizardState, action: FinancialWizardAction) => reduceFinancialWizard(current, action, view),
    view, initialFinancialWizardState,
  )
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const steps = getFinancialWizardSteps(view, state)
  const stepIndex = steps.indexOf(state.step)
  const moneyOptions = getFinancialMoneyOptions(view, state.product)
  const choiceCopy = state.choice ? FINANCIAL_CHOICE_COPY[state.choice] : null
  const receptionLabel = getFinancialReceptionLabel(view, state)

  const submit = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await financialRequest(pedido.id, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildFinancialResolvePayload(view, state)),
      })
      setConfirming(false)
      onChanged()
    } catch (requestError) {
      setConfirming(false)
      setError(requestError instanceof Error ? requestError.message : "No se pudo confirmar la resolución.")
    } finally {
      setSaving(false)
    }
  }

  if (waiting) {
    return (
      <div className="admin-financial-wizard-body mt-3 grid content-start gap-3" data-step="waiting">
        <p className="text-sm font-black text-[var(--admin-text)]">Esperando recepción del producto</p>
        <p className="text-xs font-semibold text-[var(--admin-text-soft)]">El reintegro se resuelve cuando BEYONIX lo reciba.</p>
        <div><AdminButton size="sm" onClick={() => setWaiting(false)}>Resolver ahora</AdminButton></div>
      </div>
    )
  }

  return (
    <>
      <ol className="admin-financial-wizard-steps mt-3" aria-label="Pasos de la resolución">
        {steps.map((step, index) => (
          <li key={step} aria-current={step === state.step ? "step" : undefined}
            className={step === state.step ? "is-current" : index < stepIndex ? "is-done" : ""}>
            <span className="admin-financial-wizard-step-number">{index < stepIndex ? <Check className="size-3" /> : index + 1}</span>
            {FINANCIAL_STEP_LABELS[step]}
          </li>
        ))}
      </ol>

      <div className="admin-financial-wizard-body mt-3" data-step={state.step}>
        {state.step === "product" && (
          <fieldset className="grid gap-3">
            <legend className="text-sm font-black text-[var(--admin-text)]">¿Qué pasa con el producto?</legend>
            {view.notice && <p className="admin-financial-wizard-notice">{view.notice}</p>}
            <div role="radiogroup" className="admin-financial-wizard-options">
              {(["no_return", "return"] as const).map((value) => (
                <OptionCard key={value} selected={state.product === value} disabled={!isProductOptionAvailable(view, value)}
                  title={FINANCIAL_PRODUCT_COPY[value].label} description={FINANCIAL_PRODUCT_COPY[value].description}
                  onSelect={() => dispatch({ type: "product", value })} />
              ))}
            </div>
          </fieldset>
        )}

        {state.step === "money" && (
          <fieldset className="grid gap-3">
            <legend className="text-sm font-black text-[var(--admin-text)]">¿Cómo querés resolver {formatPrice(view.amount)}?</legend>
            <div role="radiogroup" className="admin-financial-wizard-options">
              {moneyOptions.map((option) => (
                <OptionCard key={option.type} selected={state.choice === option.type}
                  title={FINANCIAL_CHOICE_COPY[option.type].label} description={FINANCIAL_CHOICE_COPY[option.type].description}
                  onSelect={() => dispatch({ type: "choice", value: option.type })} />
              ))}
            </div>
          </fieldset>
        )}

        {state.step === "reception" && (
          <fieldset className="grid gap-3">
            <legend className="text-sm font-black text-[var(--admin-text)]">¿El producto ya fue recibido?</legend>
            <div role="radiogroup" className="admin-financial-wizard-options">
              <OptionCard selected={state.receptionAnswer === "yes"} title="Sí" description="BEYONIX ya tiene el producto."
                onSelect={() => dispatch({ type: "reception", value: "yes" })} />
              <OptionCard selected={state.receptionAnswer === "no"} title="No" description="Todavía no llegó."
                onSelect={() => dispatch({ type: "reception", value: "no" })} />
            </div>
            {state.receptionAnswer === "yes" && (
              <div className="admin-financial-wizard-notice flex flex-wrap items-center justify-between gap-2">
                <span>Registrá la recepción en Atención para continuar.</span>
                <AdminButton size="sm" onClick={onOpenAttention}>Ir a Atención</AdminButton>
              </div>
            )}
            {state.receptionAnswer === "no" && !state.exception && (
              <div className="grid gap-2">
                <p className="text-xs font-semibold text-[var(--admin-text-soft)]">El reintegro normalmente se completa después de recibir el producto.</p>
                <div className="flex flex-wrap gap-2">
                  <AdminButton size="sm" onClick={() => setWaiting(true)}>Esperar recepción</AdminButton>
                  <AdminButton size="sm" variant="ghost" onClick={() => dispatch({ type: "exception" })}>Continuar con excepción</AdminButton>
                </div>
              </div>
            )}
            {state.exception && (
              <label className="grid gap-1.5">
                <span className="text-11px font-black uppercase tracking-widest text-[var(--admin-text-muted)]">Motivo de la excepción</span>
                <AdminTextarea title="Motivo de la excepción" value={state.exceptionReason} maxLength={1000} required
                  className="min-h-20" onChange={(value) => dispatch({ type: "reason", value })} />
                <span className="text-11px font-semibold text-[var(--admin-text-muted)]">
                  Obligatorio (mínimo {EXCEPTION_REASON_MIN_LENGTH} caracteres). Queda registrado con tu usuario.
                </span>
              </label>
            )}
          </fieldset>
        )}

        {state.step === "review" && (
          <dl className="admin-financial-wizard-summary">
            <SummaryRow label="Pedido" value={orderNumber} />
            <SummaryRow label="Cliente" value={customerName} />
            {reason && <SummaryRow label="Motivo" value={reason} />}
            <SummaryRow label="Importe" value={formatPrice(view.amount)} strong />
            <SummaryRow label="Producto" value={state.product ? FINANCIAL_PRODUCT_COPY[state.product].label : "-"} />
            <SummaryRow label="Recepción" value={receptionLabel} />
            <SummaryRow label="Resolución" value={choiceCopy?.short ?? "-"} />
            <SummaryRow label="Nota de crédito" value="Se emitirá automáticamente si corresponde." />
          </dl>
        )}
      </div>

      {error && <p role="alert" className="admin-financial-wizard-error mt-3">{error}</p>}

      <footer className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {stepIndex > 0 && (
          <AdminButton size="sm" variant="ghost" icon={<ArrowLeft className="size-3.5" />} onClick={() => dispatch({ type: "back" })}>Volver</AdminButton>
        )}
        {state.step === "review" ? (
          <AdminButton size="sm" variant="primary" icon={<CheckCircle2 className="size-3.5" />} onClick={() => setConfirming(true)}>
            Confirmar resolución
          </AdminButton>
        ) : (
          <AdminButton size="sm" variant="primary" disabled={!canContinueFinancialWizard(view, state)} onClick={() => dispatch({ type: "next" })}>
            Continuar <ArrowRight className="size-3.5" />
          </AdminButton>
        )}
      </footer>

      <AdminModal compact open={confirming} title="¿Confirmás esta resolución?" onClose={() => { if (!saving) setConfirming(false) }}
        footer={(
          <div className="flex justify-end gap-2">
            <AdminButton size="sm" variant="ghost" disabled={saving} onClick={() => setConfirming(false)}>Cancelar</AdminButton>
            <AdminButton size="sm" variant="primary" disabled={saving} onClick={() => void submit()}
              icon={saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}>
              {saving ? "Confirmando..." : "Confirmar"}
            </AdminButton>
          </div>
        )}>
        <dl className="admin-financial-wizard-summary is-modal">
          <SummaryRow label="Importe" value={formatPrice(view.amount)} strong />
          <SummaryRow label="Destino" value={choiceCopy?.label ?? "-"} />
          <SummaryRow label="Producto" value={state.product ? FINANCIAL_PRODUCT_COPY[state.product].label : "-"} />
          {state.product === "return" && <SummaryRow label="Recepción" value={receptionLabel} />}
        </dl>
      </AdminModal>
    </>
  )
}

function SummaryRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="admin-financial-wizard-summary-row">
      <dt>{label}</dt>
      <dd className={strong ? "is-strong" : undefined}>{value}</dd>
    </div>
  )
}

function FinancialResolutionOutcome({ pedido, view, onChanged, onOpenBilling, onDownloadCreditNote }: WizardProps) {
  const resolution = view.resolution!
  const outcome = getFinancialOutcome(resolution)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [reference, setReference] = useState("")
  const [observation, setObservation] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const creditNote = [...(pedido.order_credit_notes ?? [])]
    .filter((note) => note.status === "authorized" && note.cae && note.destination !== "none")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]

  const post = async (body: BodyInit, headers?: HeadersInit) => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await financialRequest(pedido.id, { method: "POST", headers, body })
      setRegistering(false)
      onChanged()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "No se pudo continuar.")
    } finally {
      setSaving(false)
    }
  }

  const retry = () => post(JSON.stringify({ action: "retry", confirmed: true }), { "Content-Type": "application/json" })
  const completeManual = () => {
    const form = new FormData()
    form.set("action", "complete_manual")
    form.set("confirmed", "true")
    if (reference.trim()) form.set("reference", reference.trim())
    if (observation.trim()) form.set("observation", observation.trim())
    if (file) form.set("file", file)
    return post(form)
  }

  return (
    <div className="admin-financial-wizard-body mt-3 grid content-start gap-3" data-outcome={outcome.kind}>
      {outcome.kind === "completed" && (
        <p className="admin-financial-wizard-success">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          {resolution.type === "manual_refund" ? "Reintegro completado ✅" : "Completado ✅"}
        </p>
      )}

      {outcome.kind === "processing" && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-black text-[var(--admin-text)]">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />En proceso
          </p>
          <AdminButton size="sm" variant="ghost" onClick={onChanged}>Actualizar</AdminButton>
        </div>
      )}

      {outcome.kind === "manual_pending" && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-black text-[var(--admin-text)]">Reintegro pendiente: {formatPrice(resolution.amount)}</p>
          <AdminButton size="sm" variant="primary" onClick={() => setRegistering(true)}>Registrar reintegro realizado</AdminButton>
        </div>
      )}

      {outcome.kind === "requires_action" && (
        <div className="admin-financial-wizard-notice grid gap-2">
          <p className="flex items-center gap-2 text-sm font-black">
            <AlertTriangle className="size-4" aria-hidden="true" />Actualización pendiente
          </p>
          <p className="text-xs font-semibold">BEYONIX no pudo completar una actualización interna.</p>
          <div className="flex flex-wrap gap-2">
            <AdminButton size="sm" variant="primary" disabled={saving} onClick={() => void retry()}
              icon={saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}>
              Reintentar
            </AdminButton>
            {outcome.detail && (
              <AdminButton size="sm" variant="ghost" aria-expanded={showDetail} onClick={() => setShowDetail((value) => !value)}>
                Ver detalle técnico
              </AdminButton>
            )}
          </div>
          {showDetail && outcome.detail && <pre className="admin-financial-wizard-detail">{outcome.detail}</pre>}
        </div>
      )}

      {creditNote && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-[var(--admin-text)]">Nota de crédito emitida ✅</p>
          <div className="flex gap-2">
            <AdminButton size="sm" variant="ghost" icon={<Eye className="size-3.5" />} onClick={onOpenBilling}>Ver</AdminButton>
            <AdminButton size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => onDownloadCreditNote(creditNote.id)}>Descargar</AdminButton>
          </div>
        </div>
      )}

      {error && <p role="alert" className="admin-financial-wizard-error">{error}</p>}

      <AdminModal compact open={registering} title="Registrar reintegro realizado" description={`Importe: ${formatPrice(resolution.amount)}`}
        onClose={() => { if (!saving) setRegistering(false) }}
        footer={(
          <div className="flex justify-end gap-2">
            <AdminButton size="sm" variant="ghost" disabled={saving} onClick={() => setRegistering(false)}>Cancelar</AdminButton>
            <AdminButton size="sm" variant="primary" disabled={saving} onClick={() => void completeManual()}
              icon={saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}>
              Confirmar reintegro
            </AdminButton>
          </div>
        )}>
        <div className="grid gap-3">
          <AdminTextInput title="Referencia (opcional)" placeholder="Referencia (opcional)" value={reference} maxLength={120} onChange={setReference} />
          <AdminTextarea title="Observación (opcional)" placeholder="Observación (opcional)" value={observation} maxLength={600} className="min-h-20" onChange={setObservation} />
          <label className="grid gap-1.5 text-xs font-semibold">
            <span>Comprobante (opcional)</span>
            <input type="file" accept={PROOF_ACCEPT} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
        </div>
      </AdminModal>
    </div>
  )
}
