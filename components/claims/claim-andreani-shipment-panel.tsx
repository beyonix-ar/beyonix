"use client"

import { useRef, useState } from "react"
import { Download, LoaderCircle, RefreshCw, Truck } from "lucide-react"

import { AdminButton, AdminSecondaryButton, adminControlClassName } from "@/app/admin/components/admin-controls"
import {
  getAdminClaimShipmentView,
  pickClaimShipment,
  type ClaimShipmentDirection,
} from "@/lib/orders/claim-shipment-view"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseOrderClaim } from "@/lib/supabase/types"

type Action = "create" | "sync" | "reconcile" | "label"

/**
 * Envío Andreani de un tramo del cambio (Admin): devolución o reemplazo.
 * Estado, seguimiento, modalidad, costo, etiqueta y entrega; acciones
 * idempotentes y conciliación manual tras un resultado incierto. Nunca toca
 * stock: la recepción física y el reemplazo siguen en sus pasos del wizard.
 */
export function ClaimAndreaniShipmentPanel({
  claim,
  direction,
  canManage,
  onClaimChange,
}: {
  claim: SupabaseOrderClaim
  direction: ClaimShipmentDirection
  canManage: boolean
  onClaimChange: (claim: SupabaseOrderClaim) => void
}) {
  const [pending, setPending] = useState<Action | null>(null)
  const [error, setError] = useState("")
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [resolution, setResolution] = useState<"created" | "not_created">("created")
  const [envioId, setEnvioId] = useState("")
  const [notes, setNotes] = useState("")
  const inFlightRef = useRef(false)
  const source = pickClaimShipment(claim.order_claim_shipments ?? null, direction)
  const view = getAdminClaimShipmentView(source, direction)
  // La devolución existe desde que se acepta el cambio; el reemplazo, desde
  // que se intenta generar su envío.
  if (direction === "devolucion" && !view.exists) return null

  const withSession = async (run: (token: string) => Promise<void>, action: Action) => {
    // Doble click: una sola solicitud en vuelo (la base además lo garantiza).
    if (inFlightRef.current) return
    inFlightRef.current = true
    setPending(action)
    setError("")
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setError("La sesión administrativa venció.")
        return
      }
      await run(session.access_token)
    } catch {
      setError("No se pudo completar la operación con Andreani.")
    } finally {
      inFlightRef.current = false
      setPending(null)
    }
  }

  const post = (action: Exclude<Action, "label">, extra: Record<string, unknown> = {}) =>
    withSession(async (token) => {
      const response = await fetch(`/api/admin/order-claims/${claim.id}/andreani-shipment`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ direction, action, ...extra }),
      })
      const data = (await response.json().catch(() => ({}))) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo completar la operación con Andreani.")
        return
      }
      if (action === "reconcile") setReconcileOpen(false)
      onClaimChange(data.claim)
    }, action)

  const openLabel = () =>
    withSession(async (token) => {
      const response = await fetch(`/api/admin/order-claims/${claim.id}/andreani-shipment?direction=${direction}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        setError(data.error || "No se pudo obtener la etiqueta.")
        return
      }
      const url = URL.createObjectURL(await response.blob())
      window.open(url, "_blank", "noopener")
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }, "label")

  return (
    <section className="admin-claim-wizard-action" data-claim-andreani-shipment={direction}>
      <h4 className="admin-claim-reception-heading flex items-center gap-2">
        <Truck className="size-4" aria-hidden="true" />
        {view.title} Andreani · {view.statusLabel}
      </h4>
      {view.exists && (
        <dl className="grid gap-1 text-xs text-white/75 sm:grid-cols-2">
          {view.modalityLabel && <div><dt className="inline font-semibold">Modalidad: </dt><dd className="inline">{view.modalityLabel}</dd></div>}
          {view.tracking && <div><dt className="inline font-semibold">Seguimiento: </dt><dd className="inline">{view.tracking}</dd></div>}
          {view.andreaniEstado && <div><dt className="inline font-semibold">Estado Andreani: </dt><dd className="inline">{view.andreaniEstado}</dd></div>}
          <div><dt className="inline font-semibold">Costo: </dt><dd className="inline">{view.costLabel}</dd></div>
        </dl>
      )}
      {view.delivered && (
        <p className="admin-claim-wizard-note">
          {direction === "devolucion"
            ? "Andreani entregó el producto en BEYONIX. Revisalo y registrá la recepción: el stock no se modifica hasta que lo confirmes."
            : "Andreani informó la entrega del reemplazo. Podés finalizar el reclamo."}
        </p>
      )}
      {view.manualReview && (
        <p className="admin-claim-wizard-note">Resultado incierto en Andreani: verificá la orden en Andreani y conciliá. No se reintenta automáticamente.</p>
      )}
      {(view.error || error) && <p role="alert" className="text-xs font-semibold text-red-200">{error || view.error}</p>}

      {canManage && (
        <div className="flex flex-wrap gap-2">
          {view.canCreate && (
            <AdminButton variant="primary" disabled={pending !== null} onClick={() => void post("create")}>
              {pending === "create" ? <LoaderCircle className="size-4 animate-spin" /> : <Truck className="size-4" />}
              {pending === "create" ? "Generando..." : direction === "devolucion" ? "Generar devolución Andreani" : "Generar envío del reemplazo"}
            </AdminButton>
          )}
          {view.canSync && (
            <AdminSecondaryButton disabled={pending !== null} onClick={() => void post("sync")}>
              {pending === "sync" ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {pending === "sync" ? "Consultando..." : "Consultar seguimiento"}
            </AdminSecondaryButton>
          )}
          {view.labelAvailable && (
            <AdminSecondaryButton disabled={pending !== null} onClick={() => void openLabel()}>
              {pending === "label" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
              Etiqueta
            </AdminSecondaryButton>
          )}
          {view.canReconcile && !reconcileOpen && (
            <AdminSecondaryButton disabled={pending !== null} onClick={() => setReconcileOpen(true)}>Conciliar con Andreani</AdminSecondaryButton>
          )}
        </div>
      )}

      {canManage && view.canReconcile && reconcileOpen && (
        <div className="grid gap-2 text-xs text-white/80">
          <label className="grid gap-1">
            <span className="font-semibold">¿La orden existe en Andreani?</span>
            <select className={adminControlClassName} value={resolution} onChange={(event) => setResolution(event.target.value as "created" | "not_created")}>
              <option value="created">Sí, existe (vincular)</option>
              <option value="not_created">No existe (permitir generar de nuevo)</option>
            </select>
          </label>
          {resolution === "created" && (
            <label className="grid gap-1">
              <span className="font-semibold">Número de orden Andreani</span>
              <input className={adminControlClassName} value={envioId} onChange={(event) => setEnvioId(event.target.value)} maxLength={80} />
            </label>
          )}
          <label className="grid gap-1">
            <span className="font-semibold">Cómo lo confirmaste</span>
            <textarea className={adminControlClassName} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={2} />
          </label>
          <div className="flex gap-2">
            <AdminButton variant="primary" disabled={pending !== null || notes.trim().length < 5 || (resolution === "created" && !envioId.trim())}
              onClick={() => void post("reconcile", { resolution, envioId: envioId.trim(), notes: notes.trim() })}>
              {pending === "reconcile" ? "Conciliando..." : "Confirmar conciliación"}
            </AdminButton>
            <AdminSecondaryButton disabled={pending !== null} onClick={() => setReconcileOpen(false)}>Cancelar</AdminSecondaryButton>
          </div>
        </div>
      )}
    </section>
  )
}
