"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { supabase } from "@/lib/supabase/client"
import { canConfirmDestructiveOperation, destructiveReferenceLabels, type DestructiveImpact, type DestructiveKind } from "@/lib/admin/destructive-operations"
import { AdminModal, AdminDangerButton, AdminSecondaryButton } from "./admin-controls"

async function requestImpact(path: string, body?: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error("Tu sesión venció. Volvé a iniciar sesión.")
  const response = await fetch(path, { method: body ? "POST" : "GET", cache: "no-store", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || "No se pudo consultar el impacto.")
  return data
}

export function ForceDeleteDialog({ kind, id, onClose, onDeleted }: { kind: DestructiveKind; id: string; onClose: () => void; onDeleted: () => void | Promise<void> }) {
  const [impact, setImpact] = useState<DestructiveImpact | null>(null)
  const [confirmation, setConfirmation] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const inFlight = useRef(false)
  const key = useRef<string | null>(null)
  const load = useCallback(async () => {
    setLoading(true); setImpact(null); setConfirmation(""); setError("")
    try { const data = await requestImpact(`/api/admin/destructive-operations?kind=${kind}&id=${encodeURIComponent(id)}`); setImpact(data.impact) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo cargar el impacto.") }
    finally { setLoading(false) }
  }, [id, kind])
  useEffect(() => { void load() }, [load])
  const confirm = async () => {
    if (inFlight.current || !canConfirmDestructiveOperation(impact, confirmation, loading || saving) || !impact) return
    inFlight.current = true; setSaving(true); setError("")
    key.current ??= `force-delete:${crypto.randomUUID()}`
    try {
      await requestImpact("/api/admin/destructive-operations", { kind, id, confirmation, fingerprint: impact.fingerprint, idempotencyKey: key.current })
      await onDeleted(); onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo confirmar el borrado. Reintentá con esta misma operación.") }
    finally { inFlight.current = false; setSaving(false) }
  }
  return <AdminModal open title="Confirmar eliminación irreversible" onClose={() => { if (!saving) onClose() }} footer={<div className="flex flex-wrap justify-end gap-2"><AdminSecondaryButton disabled={saving} onClick={onClose}>Cancelar</AdminSecondaryButton><AdminDangerButton disabled={!canConfirmDestructiveOperation(impact, confirmation, loading || saving)} onClick={() => void confirm()}>{saving ? "Eliminando…" : "Eliminar definitivamente"}</AdminDangerButton></div>}>
    {loading ? <p role="status">Calculando impacto actual…</p> : null}
    {error && <div role="alert" className="mb-3 text-red-200">{error}<button type="button" disabled={saving} onClick={() => void load()} className="ml-2 underline">Recargar impacto</button></div>}
    {impact && <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-2 gap-2">{[
        ["Producto", impact.product], ["Variante / SKU", [impact.variant, impact.sku].filter(Boolean).join(" · ") || "Sin variante"],
        ["Unidades recibidas", kind === "purchase" ? impact.receivedQuantity : "No corresponde"],
        ["Costo total", kind === "purchase" ? new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(impact.totalCost) : "Historial conservado"],
        ["Ventas posteriores afectadas", kind === "purchase" ? impact.affectedSales : "Ver referencias"],
        ["Stock vendible actual", impact.currentStock], ["Stock después del borrado", impact.projectedStock], ["Variantes del producto", impact.variants],
      ].map(([label, value]) => <div key={String(label)}><dt className="text-white/55">{label}</dt><dd className="break-words font-bold">{value}</dd></div>)}</dl>
      <p>{kind === "purchase" ? "Impacto contable: se elimina esta entrada de compra. Puede cambiar el costo de ventas históricas que no tengan costo congelado; no se devuelve dinero al proveedor." : "Se elimina el artículo del catálogo. Las compras, ventas y devoluciones compatibles se conservan desvinculadas; las relaciones protegidas pueden impedir el borrado. Se eliminan imágenes, reservas y registros auxiliares asociados."}</p>
      <details open><summary className="font-bold">Historial y referencias afectadas</summary><ul className="mt-2 space-y-1">{impact.references.filter((ref) => ref.count > 0).map((ref) => <li key={`${ref.table}:${ref.column}`}>{destructiveReferenceLabels[ref.table.replace("public.", "")] || "Otras referencias históricas"}: {ref.count}</li>)}</ul></details>
      <p className="font-bold text-red-200">Esta acción es irreversible. El sistema volverá a comprobar el impacto antes de borrar.</p>
      <label className="block">Escribí exactamente <strong className="break-all">{impact.confirmation}</strong><input data-autofocus aria-label="Confirmación de eliminación" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={saving} autoComplete="off" className="mt-2 w-full rounded border border-red-300/30 bg-black/30 p-3" /></label>
    </div>}
  </AdminModal>
}
