"use client"

import { useEffect, useState } from "react"
import { AdminButton, AdminSecondaryButton, AdminSelect, AdminTrackingValue, adminControlClassName } from "@/app/admin/components/admin-controls"
import { buildClaimJourney, buildClaimShipmentTrace } from "@/lib/orders/claim-shipment-trace"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseOrderClaim, SupabasePedido } from "@/lib/supabase/types"

const TEST_STATES = [
  ["generada", "Creado"],
  ["en_transito", "En tránsito"],
  ["en_sucursal", "En sucursal"],
  ["entregada", "Entregado"],
] as const

function dateLabel(value: string | null) {
  if (!value) return "Fecha pendiente"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Fecha pendiente" : date.toLocaleString("es-AR", {
    dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires",
  })
}

export function ClaimShipmentTrace({ order, claim, canManage, onClaimChange }: {
  order: SupabasePedido
  claim: SupabaseOrderClaim
  canManage: boolean
  onClaimChange: (claim: SupabaseOrderClaim) => void
}) {
  const [testEnabled, setTestEnabled] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [status, setStatus] = useState<string>("en_transito")
  const [notes, setNotes] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const rows = buildClaimShipmentTrace(order, claim)
  const journey = buildClaimJourney(order, claim)

  useEffect(() => {
    if (!canManage) return
    let active = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const response = await fetch(`/api/admin/order-claims/${claim.id}/andreani-shipment?capabilities=1`, {
        headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store",
      })
      const data = (await response.json().catch(() => ({}))) as { testStatusEnabled?: boolean }
      if (active) setTestEnabled(response.ok && data.testStatusEnabled === true)
    })()
    return () => { active = false }
  }, [canManage, claim.id])

  const submit = async (shipmentId: number) => {
    if (busy || notes.trim().length < 10) return
    setBusy(true)
    setError("")
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("La sesión administrativa venció.")
      const response = await fetch(`/api/admin/order-claims/${claim.id}/andreani-shipment`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test_status", shipmentId, status, notes: notes.trim() }),
      })
      const data = (await response.json().catch(() => ({}))) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) throw new Error(data.error || "No se pudo simular el estado.")
      onClaimChange(data.claim)
      setEditingId(null)
      setNotes("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo simular el estado.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="min-w-0" data-claim-shipment-trace>
      <h4 className="text-xs font-bold">Trazabilidad de envíos</h4>
      <ol className="mt-1.5 grid min-w-0 gap-2">
        {rows.map((row) => (
          <li key={row.key} className="min-w-0 rounded-lg border border-current/15 p-2.5" data-shipment-kind={row.title}>
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-xs">{row.title}</strong>
              {row.override === "qa" && <span className="rounded border border-amber-500/50 px-1.5 py-0.5 text-[10px] font-bold text-amber-500">SIMULADO · QA</span>}
              {row.override === "forced" && <span className="admin-claim-forced-chip" data-claim-forced-status>FORZADO · BEYONIX</span>}
            </div>
            <dl className="mt-1.5 grid min-w-0 gap-0.5 text-xs">
              <div className="flex gap-2"><dt className="shrink-0 opacity-65">N.º</dt><dd className="min-w-0 break-all">{row.number || "Pendiente"}</dd></div>
              <div className="flex items-center gap-2"><dt className="shrink-0 opacity-65">Tracking</dt><dd className="min-w-0 break-all">
                {row.tracking ? <AdminTrackingValue value={row.tracking} label={`seguimiento de ${row.title.toLowerCase()}`} /> : "Pendiente"}
              </dd></div>
              <div className="flex gap-2"><dt className="shrink-0 opacity-65">{row.override ? "Estado BEYONIX" : "Estado"}</dt><dd>{row.status}{row.override === "forced" ? " (forzado)" : ""}</dd></div>
              {row.override && <div className="flex gap-2"><dt className="shrink-0 opacity-65">Andreani</dt><dd>{row.realStatus || "Sin novedad observada"}</dd></div>}
              {row.override === "forced" && row.overrideNote && <div className="flex gap-2"><dt className="shrink-0 opacity-65">Motivo</dt><dd className="min-w-0 break-words">{row.overrideNote}</dd></div>}
              <div className="flex gap-2"><dt className="shrink-0 opacity-65">Fecha</dt><dd>{dateLabel(row.date)}</dd></div>
            </dl>
            {testEnabled && canManage && row.canSimulate && row.shipmentId && (
              editingId === row.shipmentId ? (
                <div className="mt-2 grid gap-2 border-t border-current/15 pt-2" data-claim-test-status-form>
                  <AdminSelect title="Estado simulado" ariaLabel="Estado simulado" value={status} onChange={setStatus} compact>
                    {TEST_STATES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </AdminSelect>
                  <label className="grid gap-1 text-xs">Motivo de prueba
                    <textarea className={adminControlClassName} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={2} />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <AdminButton size="sm" disabled={busy || notes.trim().length < 10} onClick={() => void submit(row.shipmentId!)}>Aplicar simulación</AdminButton>
                    <AdminSecondaryButton size="sm" disabled={busy} onClick={() => { setEditingId(null); setError("") }}>Cancelar</AdminSecondaryButton>
                  </div>
                </div>
              ) : <AdminSecondaryButton size="sm" className="mt-2" onClick={() => { setEditingId(row.shipmentId); setStatus(row.currentStatus === "generada" ? "en_transito" : row.currentStatus || "en_transito"); setNotes(""); setError("") }}>Simular estado · QA</AdminSecondaryButton>
            )}
          </li>
        ))}
      </ol>
      {journey.length > 0 && (
        <ol className="mt-2 flex min-w-0 flex-wrap gap-1.5 border-t border-current/15 pt-2 text-[11px]" aria-label="Recorrido del reclamo" data-claim-journey>
          {journey.map((event) => <li key={event.key} className="rounded-md border border-current/15 px-2 py-1">
            {event.label} <time dateTime={event.at} className="opacity-65">· {dateLabel(event.at)}</time>
          </li>)}
        </ol>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
    </section>
  )
}
