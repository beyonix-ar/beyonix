"use client"

import { useState } from "react"
import { AlertTriangle, LoaderCircle } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"
import type { ReconcilableCreditNote as ReconcilableNote } from "@/lib/arca/credit-note-reconciliation-view"

/**
 * NC que quedó a mitad de camino con ARCA (respuesta perdida, reinicio o
 * falla después de autorizar). "Conciliar con ARCA" nunca emite otra nota:
 * adopta la ya autorizada, la deja en revisión manual o la libera.
 */
export function CreditNoteReconcileAlert({
  notes,
  onBillingUpdated,
}: {
  notes: ReconcilableNote[]
  onBillingUpdated: (order: SupabasePedido) => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  if (!notes.length) return null

  const reconcile = async (noteId: string) => {
    setBusyId(noteId)
    setMessage(null)
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setMessage({ ok: false, text: "La sesión administrativa venció." })
        return
      }
      const response = await fetch(`/api/admin/credit-notes/${noteId}/reconcile`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
        message?: string
        order?: SupabasePedido
        released?: boolean
        adopted?: boolean
      }
      if (!response.ok) {
        setMessage({ ok: false, text: data.error ?? "No se pudo conciliar la nota de crédito." })
        return
      }
      if (data.order) onBillingUpdated(data.order)
      setMessage({
        ok: true,
        text: data.released
          ? data.message ?? "ARCA no había autorizado la nota. Podés volver a emitirla."
          : data.adopted
            ? "ARCA ya la había autorizado: se registró sin emitir otra nota."
            : "Nota de crédito conciliada.",
      })
    } catch {
      setMessage({ ok: false, text: "No se pudo conciliar la nota de crédito." })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="admin-order-bl-alert" data-credit-note-reconciliation role="alert">
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="admin-order-bl-alert-title">Nota de crédito pendiente de conciliación con ARCA</p>
        {notes.map((note) => (
          <div key={note.id} className="mt-1.5 flex flex-wrap items-center gap-2">
            <p className="admin-order-bl-alert-desc min-w-0 flex-1 break-words">
              {note.status === "authorized"
                ? "ARCA ya la autorizó; falta completar stock, saldo o el resumen del pedido."
                : note.error || "El resultado de ARCA no se conoce todavía."}
              {note.voucher_number ? ` (comprobante pedido ${note.voucher_point}-${note.voucher_number})` : ""}
            </p>
            <button
              type="button"
              onClick={() => void reconcile(note.id)}
              disabled={busyId !== null}
              className="admin-ds-button admin-ds-button-secondary inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 px-3 text-11px font-black uppercase tracking-wide disabled:cursor-wait disabled:opacity-60"
            >
              {busyId === note.id && <LoaderCircle className="size-3.5 animate-spin" />}
              Conciliar con ARCA
            </button>
          </div>
        ))}
        {message && (
          <p className={`mt-1.5 text-xs font-semibold ${message.ok ? "text-emerald-300" : "text-red-300"}`}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  )
}
