"use client"

import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, Download, Eye, LoaderCircle, RefreshCw, XCircle } from "lucide-react"
import { supabase } from "@/lib/supabase/client"
import {
  RETURN_PHYSICAL_STATE_LABELS, RETURN_PHYSICAL_STATES, RETURN_REJECTION_REASON_MIN_LENGTH, getReturnInspectionInputError,
  type ReturnMoneyDecision, type ReturnPhysicalState,
} from "@/lib/orders/financial-resolution"
import {
  applyFinancialResolution, buildFinancialResolvePayload, canContinueFinancialWizard, EXCEPTION_REASON_MIN_LENGTH,
  FINANCIAL_CHOICE_COPY, FINANCIAL_STEP_LABELS, RETURN_DECISION_COPY, getFinancialHumanState, getFinancialMoneyOptions,
  getFinancialOutcome, getFinancialReceptionLabel, getFinancialWizardSteps, getMerchandiseSituationLabel, getResolutionFromResponse,
  getReturnDecisionLabel, initialFinancialWizardState, isReturnMoneyRejected, mergeFinancialResolutionView, needsReturnInspection,
  reduceFinancialWizard, type FinancialResolutionView, type FinancialWizardAction, type FinancialWizardState,
} from "@/lib/orders/financial-resolution-wizard"
import { getCreditNoteState } from "@/lib/orders/credit-note-state"
import type { SupabasePedido } from "@/lib/supabase/types"
import { InvoiceViewerModal } from "@/components/account/invoice-viewer-modal"
import { AdminButton, AdminModal, AdminTextarea, AdminTextInput } from "../../components/admin-controls"
import { formatPrice } from "../productos/helpers"

const MODES = ["wizard", "resolution", "advanced", "none"]
const PROOF_ACCEPT = "image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf"
const PROCESSING_POLL_MS = 3_000
const PROCESSING_POLL_LIMIT = 10

type FinancialResolution = NonNullable<FinancialResolutionView["resolution"]>

// Operación financiera en curso por pedido. Vive fuera del componente: salir
// del pedido y volver a entrar mientras el POST sigue en vuelo no ofrece otra
// confirmación (el backend igual es idempotente por pedido).
const inFlightByOrder = new Map<number, Promise<unknown>>()

/** Ejecuta el POST una sola vez por pedido; una segunda llamada en curso devuelve null. */
function startFinancialOperation(orderId: number, init: RequestInit) {
  if (inFlightByOrder.has(orderId)) return null
  const request = financialRequest(orderId, { ...init, method: "POST" })
  inFlightByOrder.set(orderId, request)
  const release = () => { inFlightByOrder.delete(orderId) }
  request.then(release, release)
  return request
}

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
    const sameOrder = (previous: typeof result) => previous?.key.startsWith(`${orderId}:`) ? previous.view : null
    financialRequest(orderId)
      .then((data) => {
        if (cancelled) return
        const fetched = MODES.includes(data.mode ?? "") ? data as FinancialResolutionView : null
        setResult((previous) => ({ key, view: mergeFinancialResolutionView(sameOrder(previous), fetched) }))
      })
      .catch(() => { if (!cancelled) setResult((previous) => ({ key, view: sameOrder(previous) })) })
    return () => { cancelled = true }
  }, [enabled, orderId, key])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  // El backend ya confirmó: se muestra al instante, sin esperar la relectura.
  const applyResolution = useCallback((resolution: FinancialResolution) => {
    setResult((previous) => previous?.view && previous.key.startsWith(`${orderId}:`)
      ? { key: previous.key, view: applyFinancialResolution(previous.view, resolution) }
      : previous)
  }, [orderId])
  // Mientras se actualiza se conserva la vista del mismo pedido: sin parpadeo.
  const current = result?.key.startsWith(`${orderId}:`) ? result : null
  return { view: current?.view ?? null, loading: enabled && !current, reload, applyResolution }
}

type WizardProps = {
  pedido: SupabasePedido
  view: FinancialResolutionView
  orderNumber: string
  customerName: string
  reason: string | null
  onChanged: () => void
  /** Resultado confirmado por el POST: se refleja antes de releer el pedido. */
  onResolved: (resolution: FinancialResolution) => void
  onOpenAttention: () => void
  onDownloadCreditNote: (noteId: string) => void
}

export function FinancialResolutionWizard(props: WizardProps) {
  const humanState = getFinancialHumanState(props.view)
  const rejected = isReturnMoneyRejected(props.view)
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
            {rejected ? "Devolución del dinero rechazada"
              : props.view.resolution ? FINANCIAL_CHOICE_COPY[props.view.resolution.type].label : "Cancelación / reintegro"}
          </h3>
        </div>
        <p className="admin-financial-wizard-amount text-lg font-black">{formatPrice(props.view.resolution?.amount ?? props.view.amount)}</p>
      </header>
      {rejected ? <ReturnRejectedOutcome {...props} />
        : props.view.resolution ? <FinancialResolutionOutcome {...props} />
        : needsReturnInspection(props.view) ? <ReturnInspectionStep {...props} />
        : <FinancialWizardFlow {...props} />}
    </section>
  )
}

function OptionCard({ selected, disabled, title, description, onSelect }: {
  selected: boolean; disabled?: boolean; title: string; description?: string; onSelect: () => void
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect}
      className={`admin-financial-wizard-option ${selected ? "is-selected" : ""}`}>
      <span className="admin-financial-wizard-option-title">
        {selected && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
        {title}
      </span>
      {description && <span className="admin-financial-wizard-option-description">{description}</span>}
    </button>
  )
}

/** Una línea: lo que realmente pasó con el producto (nunca "No vuelve"). */
function MerchandiseLine({ view }: { view: FinancialResolutionView }) {
  return (
    <p className="text-xs font-semibold text-[var(--admin-text-soft)]" data-testid="merchandise-situation">
      <span className="font-black text-[var(--admin-text)]">Situación de la mercadería:</span> {getMerchandiseSituationLabel(view)}
    </p>
  )
}

/**
 * Bloqueo de una operación financiera: un ref síncrono (dos clicks en el mismo
 * tick no pasan), el registro por pedido y, tras un éxito, el bloqueo sigue
 * hasta que llega una vista nueva -- un refetch en curso nunca revive el botón.
 */
function useFinancialOperation(pedidoId: number, view: FinancialResolutionView, onChanged: () => void, onResolved: WizardProps["onResolved"]) {
  const lockRef = useRef(false)
  const awaitingViewRef = useRef(false)
  const onChangedRef = useRef(onChanged)
  // Abierto otra vez con la operación aún en vuelo: bloqueado desde el inicio.
  const [saving, setSaving] = useState(() => inFlightByOrder.has(pedidoId))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { onChangedRef.current = onChanged })

  useEffect(() => {
    const pending = inFlightByOrder.get(pedidoId)
    if (!pending) return
    let active = true
    const settled = () => {
      if (!active) return
      awaitingViewRef.current = true
      onChangedRef.current()
    }
    pending.then(settled, settled)
    return () => { active = false }
  }, [pedidoId])

  useEffect(() => {
    if (!awaitingViewRef.current) return
    awaitingViewRef.current = false
    lockRef.current = false
    setSaving(false)
  }, [view])

  /** "skipped": ya había una operación en curso; no se tocó nada. */
  const run = async (init: RequestInit, fallbackError: string): Promise<"skipped" | "ok" | "error"> => {
    if (lockRef.current) return "skipped"
    const request = startFinancialOperation(pedidoId, init)
    if (!request) return "skipped"
    lockRef.current = true
    setSaving(true)
    setError(null)
    try {
      const resolution = getResolutionFromResponse(await request)
      awaitingViewRef.current = true
      if (resolution) onResolved(resolution)
      return "ok"
    } catch (requestError) {
      lockRef.current = false
      setSaving(false)
      setError(requestError instanceof Error ? requestError.message : fallbackError)
      return "error"
    } finally {
      // También ante error: si el backend llegó a registrar la resolución
      // (timeout, corte de red), la relectura la muestra y no se ofrece otra.
      onChanged()
    }
  }

  // Identidad estable: el padre pasa onChanged inline en cada render.
  const refresh = useCallback(() => onChangedRef.current(), [])

  return { saving, error, run, refresh }
}

function ConfirmingNotice() {
  return (
    <div className="admin-financial-wizard-body mt-3 grid content-start gap-2" data-step="submitting" aria-live="polite">
      <p className="flex items-center gap-2 text-sm font-black text-[var(--admin-text)]">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />Confirmando resolución…
      </p>
      <p className="text-xs font-semibold text-[var(--admin-text-soft)]">No cierres ni repitas la operación: el resultado aparece acá.</p>
    </div>
  )
}

/**
 * Devolución de un pedido ya despachado: primero la recepción física y la
 * decisión del dinero (record_order_return_inspection). Aprobada, el asistente
 * sigue con Saldo / Reintegro; rechazada, termina sin mover dinero.
 */
function ReturnInspectionStep({ pedido, view, onChanged, onResolved }: WizardProps) {
  const [physicalState, setPhysicalState] = useState<ReturnPhysicalState | null>(null)
  const [decision, setDecision] = useState<ReturnMoneyDecision | null>(null)
  const [reason, setReason] = useState("")
  const [customerMessage, setCustomerMessage] = useState("")
  const [confirming, setConfirming] = useState(false)
  const operation = useFinancialOperation(pedido.id, view, onChanged, onResolved)
  const { saving, error } = operation
  const input = { physicalState: physicalState ?? undefined, decision: decision ?? undefined, reason, customerMessage }
  const inputError = physicalState && decision ? getReturnInspectionInputError(input) : null
  const ready = Boolean(physicalState && decision) && !inputError

  const selectState = (value: ReturnPhysicalState) => {
    setPhysicalState(value)
    // Sin mercadería recibida no hay aprobación posible.
    if (value === "not_received" && decision === "approved") setDecision(null)
  }

  const submit = async () => {
    const result = await operation.run({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "inspect", confirmed: true, physicalState, decision, reason: reason.trim(), customerMessage: customerMessage.trim() }),
    }, "No se pudo registrar la inspección.")
    if (result !== "skipped") setConfirming(false)
  }

  if (saving && !confirming) return <ConfirmingNotice />

  return (
    <>
      <div className="admin-financial-wizard-body mt-3 grid gap-3" data-step="inspection">
        <MerchandiseLine view={view} />
        <fieldset className="grid gap-2">
          <legend className="text-sm font-black text-[var(--admin-text)]">¿Cómo se recibió la mercadería?</legend>
          <div role="radiogroup" aria-label="Recepción de la mercadería" className="admin-financial-wizard-options">
            {RETURN_PHYSICAL_STATES.map((value) => (
              <OptionCard key={value} selected={physicalState === value} title={RETURN_PHYSICAL_STATE_LABELS[value]}
                onSelect={() => selectState(value)} />
            ))}
          </div>
        </fieldset>
        {physicalState && (
          <fieldset className="grid gap-2">
            <legend className="text-sm font-black text-[var(--admin-text)]">Devolución del dinero ({formatPrice(view.amount)})</legend>
            <div role="radiogroup" aria-label="Decisión del dinero" className="admin-financial-wizard-options">
              <OptionCard selected={decision === "approved"} disabled={physicalState === "not_received"}
                title={RETURN_DECISION_COPY.approved}
                description={physicalState === "not_received" ? "Requiere la mercadería recibida." : undefined}
                onSelect={() => setDecision("approved")} />
              <OptionCard selected={decision === "rejected"} title={RETURN_DECISION_COPY.rejected}
                onSelect={() => setDecision("rejected")} />
            </div>
          </fieldset>
        )}
        {decision === "rejected" && (
          <div className="grid gap-2">
            <label className="grid gap-1.5">
              <span className="text-11px font-black uppercase tracking-widest text-[var(--admin-text-muted)]">Motivo del rechazo (interno)</span>
              <AdminTextarea title="Motivo del rechazo" value={reason} maxLength={600} required className="min-h-16" onChange={setReason} />
              <span className="text-11px font-semibold text-[var(--admin-text-muted)]">
                Obligatorio (mínimo {RETURN_REJECTION_REASON_MIN_LENGTH} caracteres). Queda registrado con tu usuario. No se acredita saldo ni se reintegra.
              </span>
            </label>
            <label className="grid gap-1.5">
              <span className="text-11px font-black uppercase tracking-widest text-[var(--admin-text-muted)]">Mensaje para el cliente (opcional)</span>
              <AdminTextInput title="Mensaje para el cliente" placeholder="Se suma al aviso al cliente" value={customerMessage} maxLength={300} onChange={setCustomerMessage} />
            </label>
          </div>
        )}
      </div>

      {(error || inputError) && <p role="alert" className="admin-financial-wizard-error mt-3">{error || inputError}</p>}

      <footer className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <AdminButton size="sm" variant="primary" disabled={!ready || saving} icon={<CheckCircle2 className="size-3.5" />} onClick={() => setConfirming(true)}>
          Registrar decisión
        </AdminButton>
      </footer>

      <AdminModal compact open={confirming} title="¿Confirmás esta decisión?" onClose={() => { if (!saving) setConfirming(false) }}
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
          <SummaryRow label="Situación" value={physicalState ? RETURN_PHYSICAL_STATE_LABELS[physicalState] : "-"} />
          <SummaryRow label="Resolución" value={decision ? RETURN_DECISION_COPY[decision] : "-"} />
          {decision === "rejected" && <SummaryRow label="Motivo" value={reason.trim()} />}
        </dl>
      </AdminModal>
    </>
  )
}

function FinancialWizardFlow({ view, orderNumber, customerName, reason, onChanged, onResolved, onOpenAttention, pedido }: WizardProps) {
  const [state, dispatch] = useReducer(
    (current: FinancialWizardState, action: FinancialWizardAction) => reduceFinancialWizard(current, action, view),
    view, initialFinancialWizardState,
  )
  const [confirming, setConfirming] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const operation = useFinancialOperation(pedido.id, view, onChanged, onResolved)
  const { saving, error } = operation
  const steps = getFinancialWizardSteps(view, state)
  const stepIndex = steps.indexOf(state.step)
  const moneyOptions = getFinancialMoneyOptions(view, state.product)
  const choiceCopy = state.choice ? FINANCIAL_CHOICE_COPY[state.choice] : null
  const merchandise = getMerchandiseSituationLabel(view)
  const returnDecision = getReturnDecisionLabel(view)
  const showReception = steps.includes("reception")
  const receptionLabel = getFinancialReceptionLabel(view, state)

  const submit = async () => {
    const result = await operation.run({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildFinancialResolvePayload(view, state)),
    }, "No se pudo confirmar la resolución.")
    if (result !== "skipped") setConfirming(false)
  }

  // Confirmada (o en curso desde otra apertura del pedido): bloqueado hasta
  // que la vista traiga la resolución. Sin "Volver" ni otra confirmación.
  if (saving && !confirming) return <ConfirmingNotice />

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

      <div className="admin-financial-wizard-body mt-3 grid gap-3" data-step={state.step}>
        {state.step !== "review" && <MerchandiseLine view={view} />}
        {state.step === "money" && (
          <fieldset className="grid gap-3">
            <legend className="text-sm font-black text-[var(--admin-text)]">¿Cómo querés resolver {formatPrice(view.amount)}?</legend>
            {view.notice && <p className="admin-financial-wizard-notice">{view.notice}</p>}
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
            <SummaryRow label="Situación de la mercadería" value={merchandise} />
            {showReception && <SummaryRow label="Recepción" value={receptionLabel} />}
            {returnDecision && <SummaryRow label="Resolución" value={returnDecision} />}
            <SummaryRow label="Destino" value={choiceCopy?.short ?? "-"} />
            <SummaryRow label="Nota de crédito" value="Se emitirá automáticamente si corresponde." />
          </dl>
        )}
      </div>

      {error && <p role="alert" className="admin-financial-wizard-error mt-3">{error}</p>}

      <footer className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {stepIndex > 0 && (
          <AdminButton size="sm" variant="ghost" disabled={saving} icon={<ArrowLeft className="size-3.5" />} onClick={() => dispatch({ type: "back" })}>Volver</AdminButton>
        )}
        {state.step === "review" ? (
          <AdminButton size="sm" variant="primary" disabled={saving} icon={<CheckCircle2 className="size-3.5" />} onClick={() => setConfirming(true)}>
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
          <SummaryRow label="Situación de la mercadería" value={merchandise} />
          {showReception && <SummaryRow label="Recepción" value={receptionLabel} />}
          {returnDecision && <SummaryRow label="Resolución" value={returnDecision} />}
          <SummaryRow label="Destino" value={choiceCopy?.label ?? "-"} />
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

function useCreditNotePreview(pedido: SupabasePedido) {
  const [preview, setPreview] = useState<{ noteId: string; token: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = async (noteId: string) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      setError("Iniciá sesión nuevamente para ver la nota de crédito.")
      return
    }
    setError(null)
    setPreview({ noteId, token: session.access_token })
  }
  const note = [...(pedido.order_credit_notes ?? [])]
    .filter((item) => item.status === "authorized" && item.cae)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
  const creditNoteState = getCreditNoteState(pedido)
  const label = note ? "Emitida" : creditNoteState.state === "not_required" ? "No corresponde" : "Pendiente"
  const modal = preview && (
    // Mismo visor y endpoint que Facturación: sin navegar fuera de la resolución.
    <InvoiceViewerModal
      title="Nota de crédito"
      orderId={pedido.id}
      requestUrl={`/api/admin/orders/${pedido.id}/invoice/pdf?type=credit_note&note=${encodeURIComponent(preview.noteId)}`}
      bearerToken={preview.token}
      documentLabel="nota de crédito"
      onClose={() => setPreview(null)}
    />
  )
  return { note, label, open, modal, error }
}

function CreditNoteActions({ noteId, onOpen, onDownload }: { noteId: string; onOpen: (noteId: string) => void; onDownload: (noteId: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <AdminButton size="sm" variant="ghost" icon={<Eye className="size-3.5" />} onClick={() => onOpen(noteId)}>Ver nota de crédito</AdminButton>
      <AdminButton size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => onDownload(noteId)}>Descargar</AdminButton>
    </div>
  )
}

/** Rechazo registrado: resumen final, sin acciones de dinero. */
function ReturnRejectedOutcome({ pedido, view, onDownloadCreditNote }: WizardProps) {
  const inspection = view.returnInspection!
  const creditNote = useCreditNotePreview(pedido)
  return (
    <div className="admin-financial-wizard-body mt-3 grid content-start gap-3" data-outcome="rejected">
      <dl className="admin-financial-wizard-summary" aria-label="Resumen de la resolución">
        <SummaryRow label="Estado" value="Devolución del dinero rechazada" strong />
        <SummaryRow label="Importe" value={formatPrice(view.amount)} />
        <SummaryRow label="Situación de la mercadería" value={getMerchandiseSituationLabel(view)} />
        <SummaryRow label="Resolución" value={RETURN_DECISION_COPY.rejected} />
        <SummaryRow label="Motivo" value={inspection.reason ?? "-"} />
        <SummaryRow label="Fecha" value={new Date(inspection.inspectedAt).toLocaleString("es-AR")} />
        <SummaryRow label="Nota de crédito" value={creditNote.label} />
      </dl>
      <p className="flex items-center gap-2 text-xs font-semibold text-[var(--admin-text-soft)]">
        <XCircle className="size-3.5 shrink-0" aria-hidden="true" />No se acreditó saldo ni se realizó reintegro.
      </p>
      {creditNote.note && <CreditNoteActions noteId={creditNote.note.id} onOpen={(id) => void creditNote.open(id)} onDownload={onDownloadCreditNote} />}
      {creditNote.modal}
      {creditNote.error && <p role="alert" className="admin-financial-wizard-error">{creditNote.error}</p>}
    </div>
  )
}

function FinancialResolutionOutcome({ pedido, view, onChanged, onResolved, onDownloadCreditNote }: WizardProps) {
  const resolution = view.resolution!
  const outcome = getFinancialOutcome(resolution)
  const operation = useFinancialOperation(pedido.id, view, onChanged, onResolved)
  const { saving, error } = operation
  const [showDetail, setShowDetail] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [reference, setReference] = useState("")
  const [observation, setObservation] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const creditNote = useCreditNotePreview(pedido)
  const returnDecision = getReturnDecisionLabel(view)

  // Otra solicitud tiene la operación (lease del backend): se relee sola unas
  // pocas veces en vez de ofrecer una acción que el backend rechazaría.
  const processingPolls = useRef(0)
  const isProcessing = outcome.kind === "processing"
  const { refresh } = operation
  useEffect(() => {
    if (!isProcessing || processingPolls.current >= PROCESSING_POLL_LIMIT) return
    const timer = setTimeout(() => {
      processingPolls.current += 1
      refresh()
    }, PROCESSING_POLL_MS)
    return () => clearTimeout(timer)
  }, [isProcessing, view, refresh])

  const post = async (body: BodyInit, headers?: HeadersInit) => {
    if (await operation.run({ headers, body }, "No se pudo continuar.") === "ok") setRegistering(false)
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

  const stateLabel = outcome.kind === "completed" ? "Completado"
    : outcome.kind === "manual_pending" ? "Reintegro pendiente"
    : outcome.kind === "processing" || outcome.kind === "refund_pending" ? "En proceso" : "Requiere acción"
  const mercadoPagoError = outcome.kind === "requires_action" && resolution.type === "mercadopago_refund"

  return (
    <div className="admin-financial-wizard-body mt-3 grid content-start gap-3" data-outcome={outcome.kind}>
      <dl className="admin-financial-wizard-summary" aria-label="Resumen de la resolución">
        <SummaryRow label="Estado" value={stateLabel} strong />
        <SummaryRow label="Importe" value={formatPrice(resolution.amount)} />
        <SummaryRow label="Situación de la mercadería" value={getMerchandiseSituationLabel(view)} />
        {returnDecision && <SummaryRow label="Devolución" value={returnDecision} />}
        <SummaryRow label="Resolución" value={FINANCIAL_CHOICE_COPY[resolution.type].short} />
        <SummaryRow label="Nota de crédito" value={creditNote.label} />
        {outcome.kind === "completed" && resolution.type === "mercadopago_refund" && view.resolution?.mpRefundId && (
          <SummaryRow label="ID Mercado Pago" value={view.resolution.mpRefundId} />
        )}
      </dl>

      {outcome.kind === "processing" && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-black text-[var(--admin-text)]">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            {resolution.type === "beyonix_credit" ? "Procesando acreditación…" : "Procesando reintegro…"}
          </p>
          <AdminButton size="sm" variant="ghost" onClick={refresh}>Actualizar</AdminButton>
        </div>
      )}

      {outcome.kind === "manual_pending" && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-black text-[var(--admin-text)]">Reintegro pendiente: {formatPrice(resolution.amount)}</p>
          <AdminButton size="sm" variant="primary" disabled={saving} onClick={() => setRegistering(true)}>Registrar reintegro realizado</AdminButton>
        </div>
      )}

      {outcome.kind === "refund_pending" && (
        <div className="admin-financial-wizard-notice grid gap-2" data-refund-state="pending">
          <p className="flex items-center gap-2 text-sm font-black">
            <LoaderCircle className="size-4" aria-hidden="true" />Reintegro en proceso
          </p>
          <p className="text-xs font-semibold">Mercado Pago todavía está confirmando la operación. No hace falta volver a reintegrar.</p>
          <div className="flex flex-wrap gap-2">
            {/* Sólo concilia el reintegro existente: nunca crea otro. */}
            <AdminButton size="sm" variant="primary" disabled={saving} onClick={() => void retry()}
              icon={saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}>
              Actualizar estado
            </AdminButton>
          </div>
        </div>
      )}

      {outcome.kind === "requires_action" && (
        <div className="admin-financial-wizard-notice grid gap-2" data-refund-state={mercadoPagoError ? "error" : undefined}>
          <p className="flex items-center gap-2 text-sm font-black">
            <AlertTriangle className="size-4" aria-hidden="true" />{mercadoPagoError ? "No pudimos procesar el reintegro" : "Actualización pendiente"}
          </p>
          <p className="text-xs font-semibold">{mercadoPagoError
            ? outcome.detail ?? "El reintegro no se creó en Mercado Pago. Podés reintentar."
            : "BEYONIX no pudo completar una actualización interna."}</p>
          <div className="flex flex-wrap gap-2">
            <AdminButton size="sm" variant="primary" disabled={saving} onClick={() => void retry()}
              icon={saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}>
              Reintentar
            </AdminButton>
            {outcome.detail && !mercadoPagoError && (
              <AdminButton size="sm" variant="ghost" aria-expanded={showDetail} onClick={() => setShowDetail((value) => !value)}>
                Ver detalle técnico
              </AdminButton>
            )}
          </div>
          {showDetail && outcome.detail && <pre className="admin-financial-wizard-detail">{outcome.detail}</pre>}
        </div>
      )}

      {creditNote.note && <CreditNoteActions noteId={creditNote.note.id} onOpen={(id) => void creditNote.open(id)} onDownload={onDownloadCreditNote} />}
      {creditNote.modal}

      {(error || creditNote.error) && <p role="alert" className="admin-financial-wizard-error">{error || creditNote.error}</p>}

      <AdminModal compact open={registering} title="Registrar reintegro realizado" description={`Importe: ${formatPrice(resolution.amount)}`}
        onClose={() => { if (!saving) setRegistering(false) }}
        footer={(
          <div className="flex justify-end gap-2">
            <AdminButton size="sm" variant="ghost" disabled={saving} onClick={() => setRegistering(false)}>Cancelar</AdminButton>
            <AdminButton size="sm" variant="primary" disabled={saving || !file} onClick={() => void completeManual()}
              icon={saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}>
              Confirmar reintegro
            </AdminButton>
          </div>
        )}>
        <div className="grid gap-3">
          <AdminTextInput title="Referencia (opcional)" placeholder="Referencia (opcional)" value={reference} maxLength={120} onChange={setReference} />
          <AdminTextarea title="Observación (opcional)" placeholder="Observación (opcional)" value={observation} maxLength={600} className="min-h-20" onChange={setObservation} />
          <label className="grid gap-1.5 text-xs font-semibold">
            <span>Comprobante del reintegro (obligatorio)</span>
            <input type="file" accept={PROOF_ACCEPT} required onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
        </div>
      </AdminModal>
    </div>
  )
}
