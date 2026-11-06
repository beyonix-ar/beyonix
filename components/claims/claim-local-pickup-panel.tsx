"use client"

import { useRef, useState } from "react"
import { Bike, CalendarDays, CheckCircle2, PackageCheck } from "lucide-react"

import { AdminButton, AdminGhostButton, AdminSecondaryButton, adminControlClassName } from "@/app/admin/components/admin-controls"
import { AdminDatePicker } from "@/app/admin/components/admin-date-picker"
import { HelpTip } from "@/components/claims/help-tip"
import { getOrCreateIdempotencyAttempt, type IdempotencyAttempt } from "@/lib/business/idempotency-attempt"
import type { ClaimLocalPickupAdminView } from "@/lib/orders/claim-local-pickup"
import {
  CLAIM_INCIDENT_LABELS,
  type ClaimIncidentType,
  type ClaimLogisticsItemView,
  type ClaimLogisticsMethodChoice,
} from "@/lib/orders/claim-shipment-view"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseOrderClaim } from "@/lib/supabase/types"

type LocalMethod = "retiro_cadete" | "sin_devolucion_local"
type PickupForm = "schedule" | "collected" | "incident" | "cancel" | "receive"

const INCIDENT_TYPES = Object.keys(CLAIM_INCIDENT_LABELS) as ClaimIncidentType[]

const todayInArgentina = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date())

function useLocalPickupRequest(claimId: number, onClaimChange: (claim: SupabaseOrderClaim) => void) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const inFlightRef = useRef(false)
  const post = async (payload: Record<string, unknown>, onDone?: () => void) => {
    // Doble clic: una sola solicitud en vuelo (la base además es idempotente).
    if (inFlightRef.current) return
    inFlightRef.current = true
    setPending(true)
    setError("")
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setError("La sesión administrativa venció.")
        return
      }
      const response = await fetch(`/api/admin/order-claims/${claimId}/local-pickup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = (await response.json().catch(() => ({}))) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo completar la operación.")
        return
      }
      onDone?.()
      onClaimChange(data.claim)
    } catch {
      setError("No se pudo completar la operación.")
    } finally {
      inFlightRef.current = false
      setPending(false)
    }
  }
  return { pending, error, post }
}

/**
 * Paso Logística de un pedido Envío BEYONIX: retiro por cadete o "no requiere
 * devolución". Sin sucursales ni Andreani; la solución comercial no cambia.
 */
export function ClaimLocalMethodForm({
  claimId,
  method,
  choice,
  onCancel,
  onClaimChange,
}: {
  claimId: number
  method: LocalMethod
  choice: ClaimLogisticsMethodChoice | null
  onCancel: () => void
  onClaimChange: (claim: SupabaseOrderClaim) => void
}) {
  const { pending, error, post } = useLocalPickupRequest(claimId, onClaimChange)
  const [notes, setNotes] = useState("")
  const [confirming, setConfirming] = useState(false)
  const waive = method === "sin_devolucion_local"
  const submit = () => {
    if (waive && !confirming) {
      setConfirming(true)
      return
    }
    void post(waive ? { action: "waive", notes: notes.trim() } : { action: "request", notes: notes.trim() || undefined }, onCancel)
  }
  return (
    <div className="admin-claim-method-form" data-claim-local-method={method}>
      {choice && (
        <p className="admin-claim-method-form-title">
          {choice.label}
          <HelpTip label={choice.label} align="start">{choice.description}</HelpTip>
        </p>
      )}
      {!waive && (
        <p className="admin-claim-logistics-hint">
          El cliente verá: “Coordinaremos con vos el retiro del producto en tu domicilio.” La fecha se acuerda después por la conversación del reclamo.
        </p>
      )}
      <label className="grid gap-1">
        <span className="admin-claim-logistics-label">{waive ? "Motivo (obligatorio, mínimo 10 caracteres)" : "Nota interna (opcional)"}</span>
        <textarea className={`${adminControlClassName} admin-claim-compact-textarea`} value={notes} maxLength={1000} rows={2}
          onChange={(event) => { setNotes(event.target.value); setConfirming(false) }} />
      </label>
      {confirming && (
        <p role="alert" className="admin-claim-logistics-warning">
          El cliente conserva el producto y no se podrá pedir la devolución después. Queda auditado con tu usuario y el motivo. ¿Confirmás?
        </p>
      )}
      {error && <p role="alert" className="text-xs font-semibold text-red-200">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <AdminButton size="sm" variant="primary" disabled={pending || (waive && notes.trim().length < 10)} onClick={submit}>
          {pending ? "Guardando..." : confirming ? "Sí, confirmar" : waive ? "Confirmar sin devolución" : "Coordinar retiro por cadete"}
        </AdminButton>
        <AdminSecondaryButton size="sm" disabled={pending} onClick={onCancel}>Cancelar</AdminSecondaryButton>
      </div>
    </div>
  )
}

/**
 * Retiro por cadete vigente: coordinar (fecha opcional), retirado, incidencia,
 * cancelar (antes de retirar) y la recepción en BEYONIX con cantidades por
 * producto, parcial permitida y confirmación explícita. Retirado nunca es
 * recibido: no mueve stock ni inspecciona.
 */
export function ClaimLocalPickupPanel({
  claimId,
  pickup,
  items,
  itemLabel,
  canManage,
  onClaimChange,
}: {
  claimId: number
  pickup: ClaimLocalPickupAdminView
  items: ClaimLogisticsItemView[]
  itemLabel: (orderItemId: number) => string
  canManage: boolean
  onClaimChange: (claim: SupabaseOrderClaim) => void
}) {
  const { pending, error, post } = useLocalPickupRequest(claimId, onClaimChange)
  const [form, setForm] = useState<PickupForm | null>(null)
  const [notes, setNotes] = useState("")
  const [agreedFor, setAgreedFor] = useState("")
  const [received, setReceived] = useState<Record<number, number>>({})
  const [incidents, setIncidents] = useState<Record<number, ClaimIncidentType | "">>({})
  const [confirming, setConfirming] = useState(false)
  const attemptRef = useRef<IdempotencyAttempt | null>(null)

  // Esperado por producto: originales que todavía no llegaron (con el cliente o el cadete).
  const expected = items
    .map((item) => ({ orderItemId: item.orderItemId, pending: item.original.con_cliente ?? 0 }))
    .filter((item) => item.pending > 0)
  const open = (next: PickupForm) => {
    setForm(next)
    setNotes("")
    setConfirming(false)
    setAgreedFor(next === "schedule" ? "" : agreedFor)
    if (next === "receive") {
      setReceived(Object.fromEntries(expected.map((item) => [item.orderItemId, item.pending])))
      setIncidents({})
      attemptRef.current = null
    }
  }
  const close = () => {
    setForm(null)
    setConfirming(false)
  }

  const receptionPayload = expected.map((item) => ({
    orderItemId: item.orderItemId,
    quantity: Math.max(0, Math.min(item.pending, received[item.orderItemId] ?? 0)),
    incidentType: incidents[item.orderItemId] || undefined,
  }))
  const receivedTotal = receptionPayload.reduce((sum, item) => sum + item.quantity, 0)
  const expectedTotal = expected.reduce((sum, item) => sum + item.pending, 0)
  const hasIncident = receptionPayload.some((item) => item.incidentType)
  const receptionValid = (receivedTotal > 0 || hasIncident) && (!hasIncident || notes.trim().length >= 5)
  const notesMin = form === "cancel" ? 10 : form === "incident" ? 5 : form === "receive" && hasIncident ? 5 : 0

  const submit = () => {
    if (!form) return
    if (form === "receive") {
      if (!confirming) {
        setConfirming(true)
        return
      }
      const payload = { action: "receive", items: receptionPayload, notes: notes.trim() || undefined }
      // Mismos datos = misma clave: un reintento tras un timeout nunca registra dos veces.
      const attempt = getOrCreateIdempotencyAttempt(attemptRef.current, { claimId, ...payload }, "claim-local-pickup")
      attemptRef.current = attempt
      void post({ ...payload, idempotencyKey: attempt.key }, () => {
        attemptRef.current = null
        close()
      })
      return
    }
    if (form === "cancel" && !confirming) {
      setConfirming(true)
      return
    }
    void post({
      action: form,
      notes: notes.trim() || undefined,
      ...(form === "schedule" ? { agreedFor } : {}),
    }, close)
  }

  const busy = pending || form !== null
  return (
    <div className="admin-claim-local-pickup grid gap-2" data-claim-local-pickup={pickup.status}>
      <p className="admin-claim-logistics-hint flex flex-wrap items-center gap-1.5" data-claim-local-pickup-status>
        <Bike className="size-3.5" aria-hidden="true" />
        <strong className="text-white">Retiro por cadete:</strong> {pickup.statusLabel}
        {pickup.agreedFor && <span>· acordado para el {pickup.agreedFor}</span>}
        {pickup.pendingUnits > 0 && pickup.status !== "pendiente_coordinacion" && pickup.status !== "coordinado" && (
          <span>· faltan {pickup.pendingUnits} {pickup.pendingUnits === 1 ? "unidad" : "unidades"}</span>
        )}
      </p>
      {pickup.incident && <p role="status" className="admin-claim-logistics-warning" data-claim-local-pickup-incident>Incidencia: {pickup.incident}</p>}
      {pickup.status === "retirado" && (
        <p className="admin-claim-logistics-hint">El cadete tiene el producto: todavía no llegó a BEYONIX (nada se inspecciona ni vuelve a stock).</p>
      )}

      {canManage && !form && (
        <div className="admin-claim-current-action flex flex-wrap items-center gap-1.5" data-claim-local-pickup-actions>
          {pickup.canReceive && (
            <AdminButton size="sm" variant="primary" disabled={busy} onClick={() => open("receive")} data-claim-primary="local-receive">
              <PackageCheck className="size-4" aria-hidden="true" />Confirmar recepción
            </AdminButton>
          )}
          {pickup.canMarkCollected && (
            <AdminButton size="sm" variant={pickup.status === "coordinado" ? "primary" : "secondary"} disabled={busy} onClick={() => open("collected")}>
              <CheckCircle2 className="size-4" aria-hidden="true" />Marcar como retirado
            </AdminButton>
          )}
          {pickup.canSchedule && (
            <AdminSecondaryButton size="sm" disabled={busy} onClick={() => open("schedule")}>
              <CalendarDays className="size-4" aria-hidden="true" />{pickup.agreedFor ? "Cambiar fecha acordada" : "Registrar fecha acordada"}
            </AdminSecondaryButton>
          )}
          {pickup.canReportIncident && (
            <AdminGhostButton size="sm" disabled={busy} onClick={() => open("incident")}>
              {pickup.collected ? "Registrar incidencia" : "Retiro fallido"}
            </AdminGhostButton>
          )}
          {pickup.canCancel && (
            <AdminGhostButton size="sm" disabled={busy} onClick={() => open("cancel")} data-claim-focus="cancel_local_pickup">Cancelar retiro</AdminGhostButton>
          )}
        </div>
      )}

      {canManage && form && (
        <div className="admin-claim-method-form" data-claim-local-pickup-form={form}>
          {form === "schedule" && (
            <label className="grid gap-1">
              <span className="admin-claim-logistics-label">Fecha acordada con el cliente</span>
              <AdminDatePicker title="Fecha acordada" ariaLabel="Fecha acordada con el cliente" value={agreedFor} minDate={todayInArgentina()} compact onChange={setAgreedFor} />
            </label>
          )}
          {form === "collected" && (
            <p className="admin-claim-logistics-hint">Confirmá que el cadete tiene físicamente el producto. No es la recepción en BEYONIX.</p>
          )}
          {form === "cancel" && <p className="admin-claim-logistics-hint">Sólo antes de que el cadete retire el producto. Después podés elegir otra opción.</p>}
          {form === "receive" && (
            <div className="grid gap-2" data-claim-local-reception>
              <p className="admin-claim-logistics-hint">Registrá lo que el cadete entregó en BEYONIX. Lo que no llegue queda pendiente; si falta o llegó dañado, elegí la novedad y explicala.</p>
              <ul className="grid gap-2">
                {expected.map((item) => (
                  <li key={item.orderItemId} className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end" data-claim-local-reception-item={item.orderItemId}>
                    <div className="min-w-0">
                      <p className="font-semibold text-white">{itemLabel(item.orderItemId)}</p>
                      <p className="admin-claim-logistics-hint">Esperadas: {item.pending}</p>
                    </div>
                    <label className="grid gap-1">
                      <span className="admin-claim-logistics-label">Recibidas</span>
                      <input type="number" min={0} max={item.pending} inputMode="numeric"
                        aria-label={`Unidades recibidas · ${itemLabel(item.orderItemId)}`}
                        className={`${adminControlClassName} admin-claim-compact-input w-24`}
                        value={received[item.orderItemId] ?? 0}
                        onChange={(event) => {
                          const value = Math.max(0, Math.min(item.pending, Math.trunc(Number(event.target.value) || 0)))
                          setReceived((current) => ({ ...current, [item.orderItemId]: value }))
                          setConfirming(false)
                        }} />
                    </label>
                    <label className="grid gap-1">
                      <span className="admin-claim-logistics-label">Novedad</span>
                      <select className={`${adminControlClassName} admin-claim-compact-input`} value={incidents[item.orderItemId] ?? ""}
                        aria-label={`Novedad · ${itemLabel(item.orderItemId)}`}
                        onChange={(event) => {
                          setIncidents((current) => ({ ...current, [item.orderItemId]: event.target.value as ClaimIncidentType | "" }))
                          setConfirming(false)
                        }}>
                        <option value="">Sin novedad</option>
                        {INCIDENT_TYPES.map((type) => <option key={type} value={type}>{CLAIM_INCIDENT_LABELS[type]}</option>)}
                      </select>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {form !== "schedule" && (
            <label className="grid gap-1">
              <span className="admin-claim-logistics-label">
                {form === "incident" ? "Qué pasó" : form === "cancel" ? "Motivo" : "Observación"}
                {notesMin ? ` (mínimo ${notesMin} caracteres)` : " (opcional)"}
              </span>
              <textarea className={`${adminControlClassName} admin-claim-compact-textarea`} value={notes} maxLength={1000} rows={2}
                onChange={(event) => { setNotes(event.target.value); setConfirming(false) }} />
            </label>
          )}
          {confirming && form === "receive" && (
            <p role="alert" className="admin-claim-logistics-warning" data-claim-local-reception-confirm>
              Vas a registrar {receivedTotal} de {expectedTotal} {expectedTotal === 1 ? "unidad esperada" : "unidades esperadas"} como recibidas en BEYONIX
              {receivedTotal < expectedTotal ? "; el resto queda pendiente" : ""}. Quedan pendientes de inspección (no vuelven solas a stock). ¿Confirmás?
            </p>
          )}
          {confirming && form === "cancel" && (
            <p role="alert" className="admin-claim-logistics-warning">El retiro se cancela y queda auditado con tu usuario y el motivo. ¿Confirmás?</p>
          )}
          <div className="flex flex-wrap gap-2">
            <AdminButton size="sm" variant="primary" onClick={submit}
              disabled={pending || notes.trim().length < notesMin || (form === "schedule" && !agreedFor) || (form === "receive" && !receptionValid)}>
              {pending ? "Guardando..." : confirming ? "Sí, confirmar" : form === "receive" ? "Confirmar recepción" : "Guardar"}
            </AdminButton>
            <AdminSecondaryButton size="sm" disabled={pending} onClick={close}>Cancelar</AdminSecondaryButton>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-xs font-semibold text-red-200">{error}</p>}
    </div>
  )
}
