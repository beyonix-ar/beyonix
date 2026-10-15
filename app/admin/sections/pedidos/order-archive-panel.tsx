"use client"

import { useRef, useState } from "react"
import { Archive, ArchiveRestore, RefreshCw } from "lucide-react"

import { notifyAdminNotificationsChanged } from "@/lib/admin/admin-notifications"
import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"
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

type Mode = "archive" | "restore"
type ArchivedOrder = SupabasePedido & {
  archived_at?: string | null
  archived_by?: string | null
  archive_reason?: string | null
  customer_hidden_at?: string | null
}

/**
 * "Archivar pedido de prueba" (sólo super_admin). No borra nada: el pedido
 * sale del listado operativo y conserva pago, factura, NC y auditoría. El
 * servidor decide si se puede (bloqueos) y deja el evento de auditoría.
 */
export function OrderArchivePanel({
  pedido,
  onUpdated,
}: {
  pedido: ArchivedOrder
  onUpdated: (order: ArchivedOrder) => void
}) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [reason, setReason] = useState("")
  const [hideFromCustomer, setHideFromCustomer] = useState(false)
  const [blockers, setBlockers] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const inFlight = useRef(false)
  const archived = Boolean(pedido.archived_at)

  const request = async (method: "GET" | "POST" | "DELETE", body?: object) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error("La sesión administrativa venció.")
    const response = await fetch(`/api/admin/orders/${pedido.id}/archive`, {
      method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = (await response.json().catch(() => null)) as {
      error?: string
      reasons?: string[]
      archive?: { archived_at?: string | null; archive_reason?: string | null; customer_hidden_at?: string | null; archived_by?: string | null }
    } | null
    return { ok: response.ok, data }
  }

  const open = async (next: Mode) => {
    if (inFlight.current) return
    setMode(next)
    setReason("")
    setHideFromCustomer(false)
    setError("")
    setBlockers(null)
    if (next === "restore") return
    inFlight.current = true
    setBusy(true)
    try {
      const { ok, data } = await request("GET")
      if (!ok) throw new Error(data?.error ?? "No se pudo comprobar si el pedido se puede archivar.")
      setBlockers(data?.reasons ?? [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo comprobar si el pedido se puede archivar.")
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!mode || inFlight.current) return
    if (reason.trim().length < 5) {
      setError("Indicá el motivo (al menos 5 caracteres).")
      return
    }
    inFlight.current = true
    setBusy(true)
    setError("")
    try {
      const { ok, data } = mode === "archive"
        ? await request("POST", { reason: reason.trim(), hideFromCustomer })
        : await request("DELETE", { reason: reason.trim() })
      if (!ok) {
        if (data?.reasons?.length) setBlockers(data.reasons)
        throw new Error(data?.error ?? (mode === "archive" ? "No se pudo archivar el pedido." : "No se pudo restaurar el pedido."))
      }
      onUpdated({
        ...pedido,
        archived_at: data?.archive?.archived_at ?? null,
        archived_by: data?.archive?.archived_by ?? null,
        archive_reason: data?.archive?.archive_reason ?? null,
        customer_hidden_at: data?.archive?.customer_hidden_at ?? null,
      })
      setMode(null)
      notifyAdminNotificationsChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo completar la acción.")
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const blocked = mode === "archive" && (blockers === null || blockers.length > 0)

  return (
    <section className="admin-order-data-panel rounded-xl border p-3" aria-label="Archivo del pedido" data-testid="order-archive-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm">
          <h3 className="font-black text-[var(--admin-text)]">{archived ? "Pedido archivado" : "Archivo de pedidos de prueba"}</h3>
          <p className="mt-1 leading-6 text-[var(--admin-text-soft)]">
            {archived
              ? `Archivado el ${formatDateTime(pedido.archived_at)}: ${pedido.archive_reason ?? ""}.${pedido.customer_hidden_at ? " Oculto también en la cuenta del cliente." : " El cliente lo sigue viendo en su cuenta."}`
              : "Saca el pedido del listado operativo sin borrar nada. Pago, factura, notas de crédito y auditoría se conservan."}
          </p>
        </div>
        <AdminSecondaryButton
          className="shrink-0"
          disabled={busy}
          icon={archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
          onClick={() => void open(archived ? "restore" : "archive")}
        >
          {archived ? "Restaurar al listado" : "Archivar pedido de prueba"}
        </AdminSecondaryButton>
      </div>
      <AdminModal
        open={mode !== null}
        title={mode === "restore" ? "Restaurar pedido" : "Archivar pedido de prueba"}
        eyebrow="Super administrador"
        description={mode === "restore"
          ? "El pedido vuelve al listado operativo y a la cuenta del cliente."
          : "No se borra nada. Queda registrado quién lo archivó y por qué."}
        compact
        onClose={() => { if (!busy) setMode(null) }}
        footer={
          <div className="flex justify-end gap-2">
            <AdminSecondaryButton onClick={() => setMode(null)} disabled={busy}>Cancelar</AdminSecondaryButton>
            <AdminButton
              variant="primary"
              onClick={() => void submit()}
              disabled={busy || blocked || reason.trim().length < 5}
              icon={busy ? <RefreshCw className="size-4 animate-spin" /> : undefined}
            >
              {mode === "restore" ? "Restaurar" : "Archivar"}
            </AdminButton>
          </div>
        }
      >
        {mode === "archive" && blockers === null && busy && (
          <p className="text-sm text-[var(--admin-text-soft)]">Comprobando el pedido…</p>
        )}
        {mode === "archive" && blockers && blockers.length > 0 && (
          <div role="alert" className="text-sm" data-testid="order-archive-blockers">
            <p className="font-bold text-[var(--admin-text)]">No se puede archivar todavía:</p>
            <ul className="mt-1 list-disc pl-5 text-[var(--admin-text-soft)]">
              {blockers.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        )}
        {(mode === "restore" || (blockers && blockers.length === 0)) && (
          <>
            <AdminTextarea
              title="Motivo"
              ariaLabel={mode === "restore" ? "Motivo de la restauración" : "Motivo del archivo"}
              value={reason}
              onChange={setReason}
              maxLength={500}
              placeholder={mode === "restore" ? "Ej.: se archivó por error." : "Ej.: pedido de prueba interna del checkout."}
            />
            {mode === "archive" && (
              <label className="mt-3 flex items-start gap-2 text-sm text-[var(--admin-text)]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={hideFromCustomer}
                  onChange={(event) => setHideFromCustomer(event.target.checked)}
                />
                <span>Ocultar también en la cuenta del cliente (sólo si es una prueba interna, nunca una compra real).</span>
              </label>
            )}
          </>
        )}
        {error && <p role="alert" className="mt-2 text-sm font-bold text-[var(--admin-text)]">{error}</p>}
      </AdminModal>
    </section>
  )
}
