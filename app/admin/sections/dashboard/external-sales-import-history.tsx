"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { RefreshCw, Undo2 } from "lucide-react"

import { EXTERNAL_SALE_STOCK_EFFECT_LABELS, type ExternalSaleImportBatch } from "@/lib/business/external-sales"
import { getExternalSaleImportBatches, revertExternalSaleImportBatch } from "@/lib/supabase/queries/external-sales"
import {
  AdminBadge,
  AdminDangerButton,
  AdminEmptyState,
  AdminInfoBlock,
  AdminModal,
  AdminSecondaryButton,
  AdminTextarea,
} from "../../components/admin-controls"

const dateTime = (value: string) => new Date(value).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })

export function ExternalSalesImportHistory({
  refreshToken,
  onShowSales,
  onChanged,
}: {
  refreshToken: number
  onShowSales: (batchId: string) => void
  onChanged: (message: string) => void
}) {
  const [batches, setBatches] = useState<ExternalSaleImportBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [pending, setPending] = useState<ExternalSaleImportBatch | null>(null)
  const [reason, setReason] = useState("")
  const [reverting, setReverting] = useState(false)
  const [revertError, setRevertError] = useState("")
  const revertingRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setBatches(await getExternalSaleImportBatches())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo cargar el historial.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  const revert = async () => {
    if (!pending || revertingRef.current) return
    revertingRef.current = true
    setReverting(true)
    setRevertError("")
    try {
      const result = await revertExternalSaleImportBatch(pending.id, pending.rows_imported, reason.trim())
      setPending(null)
      onChanged(pending.stock_mode === "consume"
        ? `Tanda deshecha: ${result.reverted} ventas anuladas y su stock devuelto.`
        : `Tanda deshecha: ${result.reverted} ventas históricas anuladas. El stock no se modificó.`)
      await load()
    } catch (revertFailure) {
      setRevertError(revertFailure instanceof Error ? revertFailure.message : "No se pudo deshacer la tanda.")
    } finally {
      revertingRef.current = false
      setReverting(false)
    }
  }

  if (!loading && error && batches.length === 0) {
    return (
      <div className="rounded-2xl border border-red-400/25 bg-red-400/10 p-6 text-center text-red-100">
        <p className="text-sm font-bold">{error}</p>
        <AdminSecondaryButton className="mt-4" onClick={() => void load()}><RefreshCw className="size-4" /> Reintentar</AdminSecondaryButton>
      </div>
    )
  }
  if (!loading && batches.length === 0) {
    return <AdminEmptyState title="Todavía no hay importaciones." description="Las tandas pegadas o importadas aparecen acá, con la opción de deshacerlas." />
  }

  return (
    <>
      <div className="sales-ledger-scrollbar overflow-x-auto rounded-2xl border border-beyonix-blue-light/16 bg-black/20">
        <table className="w-full min-w-[860px] text-left text-xs text-white/72">
          <thead className="text-10px font-black uppercase tracking-widest text-white/40">
            <tr>{["Fecha", "Usuario", "Origen", "Ventas", "Modo", "Estado", "Acción"].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}</tr>
          </thead>
          <tbody>
            {batches.map((batch) => {
              const blocked = batch.status === "completed" && batch.modified_sales > 0
              return (
                <tr key={batch.id} className="border-t border-white/6 align-top">
                  <td className="whitespace-nowrap px-3 py-3">{dateTime(batch.created_at)}</td>
                  <td className="px-3 py-3">{batch.created_by_name ?? "—"}</td>
                  <td className="px-3 py-3">{batch.source === "file" ? batch.file_name : "Filas pegadas"}</td>
                  <td className="px-3 py-3 tabular-nums">
                    {batch.rows_imported}
                    {batch.rows_read > batch.rows_imported && <span className="block text-10px text-white/40">de {batch.rows_read} filas leídas</span>}
                  </td>
                  <td className="px-3 py-3">
                    <AdminBadge tone={batch.stock_mode === "consume" ? "warning" : "neutral"}>{EXTERNAL_SALE_STOCK_EFFECT_LABELS[batch.stock_mode]}</AdminBadge>
                  </td>
                  <td className="px-3 py-3">
                    {batch.status === "reverted" ? (
                      <>
                        <AdminBadge tone="danger">Deshecha</AdminBadge>
                        <span className="mt-1 block text-10px text-white/45">{batch.reverted_at ? dateTime(batch.reverted_at) : ""} · {batch.reverted_by_name ?? "—"}</span>
                      </>
                    ) : <AdminBadge tone="success">Importada</AdminBadge>}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-2">
                      <AdminSecondaryButton size="sm" onClick={() => onShowSales(batch.id)}>Ver ventas</AdminSecondaryButton>
                      {batch.status === "completed" && (
                        <AdminDangerButton size="sm" disabled={blocked} onClick={() => { setPending(batch); setReason(""); setRevertError("") }}>
                          <Undo2 className="size-3.5" /> Deshacer
                        </AdminDangerButton>
                      )}
                    </div>
                    {blocked && <p className="mt-1 max-w-56 text-10px text-amber-200">Esta tanda contiene ventas modificadas. Revisalas individualmente.</p>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <AdminModal
        open={pending !== null}
        title="Deshacer importación"
        onClose={() => { if (!revertingRef.current) setPending(null) }}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <AdminSecondaryButton disabled={reverting} onClick={() => setPending(null)}>Cancelar</AdminSecondaryButton>
            <AdminDangerButton disabled={reverting || reason.trim().length < 10} onClick={() => void revert()}>
              {reverting ? "Deshaciendo…" : "Deshacer tanda"}
            </AdminDangerButton>
          </div>
        }
      >
        {pending && (
          <div className="space-y-3 text-sm text-white/72">
            <p>Se anularán las {pending.rows_imported} ventas de la tanda del {dateTime(pending.created_at)}. Las ventas no se borran: quedan en el historial como anuladas.</p>
            <AdminInfoBlock tone={pending.stock_mode === "consume" ? "warning" : "neutral"}>
              {pending.stock_mode === "consume"
                ? "Son ventas Nuevas: su stock vuelve al inventario en la misma operación."
                : "Son ventas Históricas: el stock actual no se modifica."}
            </AdminInfoBlock>
            <AdminTextarea title="Motivo" placeholder="Motivo obligatorio (mínimo 10 caracteres)" value={reason} maxLength={500} rows={2} className="min-h-16" onChange={setReason} />
            {revertError && <p role="alert" className="text-sm text-red-200">{revertError}</p>}
          </div>
        )}
      </AdminModal>
    </>
  )
}
