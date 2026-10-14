"use client"

import { useRef, useState } from "react"
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react"

import {
  PAYMENT_INCIDENT_LABELS,
  PAYMENT_INCIDENT_RESOLUTION_LABELS,
  getPaymentIncidents,
  type PaymentIncidentAction,
  type PaymentIncidentResolution,
} from "@/lib/orders/payment-incidents"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseOrderAuditEvent, SupabasePedido } from "@/lib/supabase/types"
import { AdminButton, AdminModal, AdminSecondaryButton, AdminTextarea } from "../../components/admin-controls"

function formatDateTime(value?: string | null) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date)
}

/**
 * Incidentes de pago auditados. Los abiertos son alerta; marcarlos como
 * falso positivo o resueltos deja constancia aparte sin tocar el evento.
 */
export function PaymentIncidentsPanel({
  pedido,
  onUpdated,
}: {
  pedido: SupabasePedido & { order_audit_events?: SupabaseOrderAuditEvent[] | null }
  onUpdated: (order: SupabasePedido) => void
}) {
  const [resolving, setResolving] = useState<{ event: SupabaseOrderAuditEvent; resolution: PaymentIncidentResolution } | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const inFlight = useRef(false)
  const incidents = getPaymentIncidents(pedido.order_audit_events)
  if (!incidents.length) return null

  const submit = async () => {
    if (!resolving || inFlight.current) return
    if (note.trim().length < 3) {
      setError("Explicá brevemente por qué lo marcás así.")
      return
    }
    inFlight.current = true
    setBusy(true)
    setError("")
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("La sesión administrativa venció.")
      const response = await fetch(`/api/admin/orders/${pedido.id}/audit-incidents/${resolving.event.id}/resolve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resolution: resolving.resolution, note: note.trim() }),
      })
      const data = (await response.json().catch(() => null)) as {
        resolution?: { resolution: string; note: string; resolved_at: string }
        error?: string
      } | null
      if (!response.ok || !data?.resolution) throw new Error(data?.error ?? "No se pudo registrar la resolución.")
      const resolution = data.resolution
      onUpdated({
        ...pedido,
        order_audit_events: (pedido.order_audit_events ?? []).map((event) =>
          event.id === resolving.event.id
            ? { ...event, audit_resolution: { resolution: resolution.resolution, note: resolution.note, resolved_at: resolution.resolved_at, resolved_by_email: null } }
            : event,
        ),
      } as SupabasePedido)
      setResolving(null)
      setNote("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo registrar la resolución.")
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <section className="admin-order-data-panel rounded-xl border p-3" aria-label="Incidentes de pago">
      <h3 className="text-sm font-black text-[var(--admin-text)]">Incidentes de pago</h3>
      <ul className="mt-2 space-y-2">
        {incidents.map((event) => {
          const resolved = event.audit_resolution
          const label = PAYMENT_INCIDENT_LABELS[event.action as PaymentIncidentAction]
          return (
            <li key={event.id} className="flex flex-col gap-2 rounded-lg border border-[var(--admin-border-soft)] p-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-2">
                {resolved ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden="true" />
                )}
                <div className="min-w-0 text-sm">
                  <p className="font-bold text-[var(--admin-text)]">{label}</p>
                  <p className="text-xs text-[var(--admin-text-soft)]">
                    {formatDateTime(event.created_at)}
                    {resolved
                      ? ` · ${PAYMENT_INCIDENT_RESOLUTION_LABELS[resolved.resolution as PaymentIncidentResolution] ?? resolved.resolution}${resolved.resolved_at ? ` el ${formatDateTime(resolved.resolved_at)}` : ""}${resolved.resolved_by_email ? ` por ${resolved.resolved_by_email}` : ""}: ${resolved.note ?? ""}`
                      : " · Requiere revisión: confirmá en Mercado Pago si el dinero salió por fuera de BEYONIX."}
                  </p>
                </div>
              </div>
              {!resolved && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <AdminSecondaryButton size="sm" disabled={busy} onClick={() => { setNote(""); setError(""); setResolving({ event, resolution: "false_positive" }) }}>
                    Marcar como falso positivo
                  </AdminSecondaryButton>
                  <AdminSecondaryButton size="sm" disabled={busy} onClick={() => { setNote(""); setError(""); setResolving({ event, resolution: "resolved" }) }}>
                    Marcar como resuelto
                  </AdminSecondaryButton>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <AdminModal
        open={Boolean(resolving)}
        title={resolving?.resolution === "false_positive" ? "Marcar como falso positivo" : "Marcar como resuelto"}
        eyebrow="Incidente de pago"
        description="El evento original queda en el historial; sólo deja de figurar como alerta."
        compact
        onClose={() => { if (!busy) setResolving(null) }}
        footer={
          <div className="flex justify-end gap-2">
            <AdminSecondaryButton onClick={() => setResolving(null)} disabled={busy}>Cancelar</AdminSecondaryButton>
            <AdminButton variant="primary" onClick={() => void submit()} disabled={busy || note.trim().length < 3}
              icon={busy ? <RefreshCw className="size-4 animate-spin" /> : undefined}>
              Confirmar
            </AdminButton>
          </div>
        }
      >
        <AdminTextarea
          title="Motivo"
          ariaLabel="Motivo de la resolución"
          value={note}
          onChange={setNote}
          maxLength={500}
          placeholder="Ej.: el reintegro lo hizo BEYONIX (reintegro MP 3442447402); el aviso llegó después."
        />
        {error && <p role="alert" className="mt-2 text-sm font-bold text-[var(--admin-text)]">{error}</p>}
      </AdminModal>
    </section>
  )
}
