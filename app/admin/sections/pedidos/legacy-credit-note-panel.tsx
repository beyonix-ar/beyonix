"use client"

import { useRef, useState } from "react"
import { AlertTriangle, FileText, RefreshCw } from "lucide-react"

import { notifyAdminNotificationsChanged } from "@/lib/admin/admin-notifications"
import { getCreditNoteObligation, type CreditNoteObligationOrder } from "@/lib/orders/credit-note-obligation"
import {
  getLastLegacyCreditNoteRejection,
  getLegacyCreditNoteState,
  type LegacyCreditNoteOrder,
} from "@/lib/orders/legacy-credit-note"
import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"
import { AdminButton, AdminModal, AdminSecondaryButton } from "../../components/admin-controls"
import { formatPrice } from "../productos/helpers"

/**
 * Caso heredado: pedido facturado, ya reintegrado y con la NC obligatoria
 * pendiente. La emisión es manual y explícita (comprobante fiscal real); el
 * servidor revalida todo y la base impide una segunda emisión.
 */
export function LegacyCreditNotePanel({
  pedido,
  onUpdated,
}: {
  pedido: SupabasePedido
  onUpdated: (order: SupabasePedido) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const inFlight = useRef(false)
  const state = getLegacyCreditNoteState(pedido as LegacyCreditNoteOrder)
  if (state === "none") return null
  const obligation = getCreditNoteObligation(pedido as CreditNoteObligationOrder)
  const lastRejection = getLastLegacyCreditNoteRejection(pedido.order_audit_events)

  const emit = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setMessage(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error("La sesión administrativa venció.")
      const response = await fetch(`/api/admin/orders/${pedido.id}/legacy-credit-note`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = (await response.json().catch(() => null)) as { order?: SupabasePedido; error?: string } | null
      if (!response.ok || !data?.order) throw new Error(data?.error ?? "No se pudo emitir la nota de crédito.")
      setConfirming(false)
      setMessage({ ok: true, text: "Nota de crédito emitida y asociada a la factura." })
      onUpdated(data.order)
      notifyAdminNotificationsChanged()
    } catch (error) {
      setConfirming(false)
      setMessage({ ok: false, text: error instanceof Error ? error.message : "No se pudo emitir la nota de crédito." })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <section className="admin-order-data-panel rounded-xl border p-3" aria-label="Nota de crédito pendiente — caso heredado">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-sm font-black text-[var(--admin-text)]">
              {state === "manual_review" ? "Nota de crédito parcial — requiere revisión" : "Nota de crédito pendiente — caso heredado"}
            </h3>
            {state === "manual_review" ? (
              <p className="mt-1 text-sm leading-6 text-[var(--admin-text-soft)]">
                Las notas de crédito autorizadas suman {formatPrice(obligation.authorizedTotal)} y la factura{" "}
                {pedido.invoice_point}-{pedido.invoice_number} es por {formatPrice(obligation.invoicedTotal)}. Falta cubrir{" "}
                {formatPrice(obligation.missingAmount)}. No se emite otra nota automáticamente para no duplicar importes
                fiscales: revisalo en Facturación.
              </p>
            ) : (
              <p className="mt-1 text-sm leading-6 text-[var(--admin-text-soft)]">
                El reintegro se hizo antes de emitirse la factura {pedido.invoice_point}-{pedido.invoice_number}, y la nota de
                crédito obligatoria nunca se generó. Emitirla anula la factura en ARCA; no devuelve dinero ni acredita saldo
                porque el cliente ya recibió el reintegro.
              </p>
            )}
            {state === "pending" && lastRejection && (
              <p className="mt-1 text-xs font-semibold text-[var(--admin-warning-text)]" data-testid="legacy-credit-note-last-rejection">
                Último intento rechazado{lastRejection.at ? ` (${new Date(lastRejection.at).toLocaleString("es-AR")})` : ""}: {lastRejection.message}
              </p>
            )}
          </div>
        </div>
        {state === "manual_review" ? null : state === "pending" ? (
          <AdminButton
            variant="primary"
            className="shrink-0"
            icon={busy ? <RefreshCw className="size-4 animate-spin" /> : <FileText className="size-4" />}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Emitir nota de crédito
          </AdminButton>
        ) : (
          <p className="shrink-0 text-sm font-bold text-[var(--admin-text-soft)]">Emitiéndose en ARCA…</p>
        )}
      </div>
      {message && (
        <p role={message.ok ? "status" : "alert"} className="mt-3 text-sm font-bold text-[var(--admin-text)]">
          {message.text}
        </p>
      )}
      <AdminModal
        open={confirming}
        title="Emitir nota de crédito"
        eyebrow="Caso heredado"
        compact
        onClose={() => { if (!busy) setConfirming(false) }}
        footer={
          <div className="flex justify-end gap-2">
            <AdminSecondaryButton onClick={() => setConfirming(false)} disabled={busy}>Cancelar</AdminSecondaryButton>
            <AdminButton variant="primary" onClick={() => void emit()} disabled={busy}
              icon={busy ? <RefreshCw className="size-4 animate-spin" /> : <FileText className="size-4" />}>
              Emitir en ARCA
            </AdminButton>
          </div>
        }
      >
        <p className="text-sm leading-6 text-[var(--admin-text-soft)]">
          Se emitirá una Nota de Crédito C real por {formatPrice(Number(pedido.total ?? 0))} asociada a la factura{" "}
          {pedido.invoice_point}-{pedido.invoice_number}. No se mueve dinero ni stock.
        </p>
      </AdminModal>
    </section>
  )
}
