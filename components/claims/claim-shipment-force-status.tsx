"use client"

import { useState } from "react"
import { AlertTriangle, ShieldAlert } from "lucide-react"

import { AdminButton, AdminModal, AdminSecondaryButton, AdminSelect, adminControlClassName } from "@/app/admin/components/admin-controls"
import {
  CLAIM_SHIPMENT_STATUS_LABELS,
  getClaimForceEffects,
  getClaimForceOptions,
  getClaimShipmentOverride,
  type ClaimForceableStatus,
} from "@/lib/orders/claim-shipment-trace"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseOrderClaim, SupabaseOrderClaimShipment } from "@/lib/supabase/types"

const MIN_REASON = 10

/**
 * Estado operativo forzado del reenvío / reemplazo (sólo super admin). Cambia
 * el estado en BEYONIX, nunca en Andreani; la base vuelve a exigir rol,
 * motivo, avance sin retrocesos y deja la auditoría
 * (force_order_claim_shipment_status).
 */
export function ClaimShipmentForceStatus({ claimId, leg, canForce, onClaimChange }: {
  claimId: number
  leg: SupabaseOrderClaimShipment
  canForce: boolean
  onClaimChange: (claim: SupabaseOrderClaim) => void
}) {
  const options = canForce ? getClaimForceOptions(leg) : []
  const forced = getClaimShipmentOverride(leg) === "forced"
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<ClaimForceableStatus | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  if (!forced && options.length === 0) return null
  const target = status && options.includes(status) ? status : options[0] ?? null
  const valid = target !== null && reason.trim().length >= MIN_REASON

  const close = () => {
    if (busy) return
    setOpen(false)
    setError("")
  }

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError("")
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("La sesión administrativa venció. Volvé a ingresar.")
      const response = await fetch(`/api/admin/order-claims/${claimId}/andreani-shipment`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "force_status", shipmentId: leg.id, status: target, notes: reason.trim() }),
      })
      const data = (await response.json().catch(() => ({}))) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) throw new Error(data.error || "No se pudo forzar el estado del reenvío.")
      onClaimChange(data.claim)
      setOpen(false)
      setReason("")
      setStatus(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo forzar el estado del reenvío.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {forced && (
        <span className="admin-claim-forced-chip" data-claim-forced-status
          title={`Último estado de Andreani: ${leg.andreani_estado || "sin novedad"}`}>
          <ShieldAlert className="size-3" aria-hidden="true" />Estado forzado
        </span>
      )}
      {options.length > 0 && (
        <button type="button" className="admin-claim-progress-link" data-claim-force-status={leg.id}
          onClick={() => { setStatus(null); setReason(""); setError(""); setOpen(true) }}>
          <ShieldAlert className="size-3.5" aria-hidden="true" />Forzar estado
        </button>
      )}
      {open && target && (
        <AdminModal
          open
          compact
          eyebrow={`Reclamo #${claimId} · Acción de super admin`}
          title="Forzar estado del reenvío"
          description="Cambia sólo el estado operativo en BEYONIX. No modifica nada en Andreani."
          onClose={close}
          footer={
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <AdminSecondaryButton disabled={busy} onClick={close}>Cancelar</AdminSecondaryButton>
              <AdminButton variant="primary" disabled={!valid || busy} onClick={() => void submit()}>
                {busy ? "Aplicando..." : `Forzar: ${CLAIM_SHIPMENT_STATUS_LABELS[target]}`}
              </AdminButton>
            </div>
          }
        >
          <div className="grid gap-3" data-claim-force-form>
            <dl className="admin-claim-force-states">
              <div><dt>Estado en BEYONIX</dt><dd>{CLAIM_SHIPMENT_STATUS_LABELS[leg.status] ?? leg.status}{forced ? " (forzado)" : ""}</dd></div>
              <div><dt>Último estado de Andreani</dt><dd>{leg.andreani_estado || "Sin novedad"}</dd></div>
            </dl>
            <label className="grid gap-1">
              <span className="text-xs font-bold">Nuevo estado</span>
              <AdminSelect title="Nuevo estado del reenvío" value={target} onChange={(value) => setStatus(value as ClaimForceableStatus)}>
                {options.map((option) => <option key={option} value={option}>{CLAIM_SHIPMENT_STATUS_LABELS[option]}</option>)}
              </AdminSelect>
            </label>
            <div className="admin-claim-force-effects" role="note" data-claim-force-effects>
              <p><AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />Qué cambia al confirmar</p>
              <ul>{getClaimForceEffects(target).map((effect) => <li key={effect}>{effect}</li>)}</ul>
            </div>
            <label className="grid gap-1">
              <span className="text-xs font-bold">Motivo (obligatorio, mínimo {MIN_REASON} caracteres)</span>
              <textarea className={`${adminControlClassName} admin-claim-compact-textarea`} value={reason} maxLength={1000} rows={3}
                placeholder="Ej.: Andreani no actualizó la entrega; el cliente la confirmó por teléfono."
                onChange={(event) => setReason(event.target.value)} />
            </label>
            {error && <p role="alert" className="text-xs font-semibold text-red-400">{error}</p>}
          </div>
        </AdminModal>
      )}
    </>
  )
}
