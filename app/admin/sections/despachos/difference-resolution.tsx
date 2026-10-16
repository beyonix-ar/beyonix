"use client"

import { useState } from "react"

import { AdminButton, AdminModal, AdminPrimaryButton, AdminSelect, AdminTextarea } from "@/app/admin/components/admin-controls"
import { DISPATCH_ADJUSTMENT_PROBLEMS, DISPATCH_ADJUSTMENT_SETTLEMENTS, type DispatchAdjustmentProblem, type DispatchAdjustmentSettlement, type OrderDispatchDetail } from "@/lib/admin/dispatch"

type Line = OrderDispatchDetail["lines"][number]
export type DifferenceInput = { orderItemId: number; quantity: number; problem: DispatchAdjustmentProblem; settlement: DispatchAdjustmentSettlement; agreement: string }

const money = (value: number) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(value)

/**
 * Diferencia de pickeo (faltante, dañado, reducción acordada): cuánto sale de
 * un producto y qué se acordó con el cliente. La base calcula y audita el
 * importe; el reintegro o saldo se gestionan después, siempre a mano.
 */
export function DifferenceResolution({ open, lines, busy, error, onClose, onSubmit }: {
  open: boolean
  lines: Line[]
  busy: boolean
  error: string
  onClose: () => void
  onSubmit: (input: DifferenceInput) => void
}) {
  // Sólo productos con unidades sin pickear: lo pickeado ya está en la caja.
  const pending = lines.filter((line) => line.scanned_quantity < line.expected_quantity)
  const [itemId, setItemId] = useState("")
  const [quantity, setQuantity] = useState("")
  const [problem, setProblem] = useState<DispatchAdjustmentProblem>("stock_shortage")
  const [settlement, setSettlement] = useState<DispatchAdjustmentSettlement>("manual_refund")
  const [agreement, setAgreement] = useState("")

  const line = pending.find((item) => String(item.order_item_id) === itemId) ?? pending[0]
  const value = quantity === "" && line ? line.scanned_quantity : Number(quantity)
  const validQuantity = Boolean(line) && Number.isInteger(value) && value >= (line?.scanned_quantity ?? 0) && value < (line?.expected_quantity ?? 0)
  const missing = line && validQuantity ? line.expected_quantity - value : 0
  const valid = validQuantity && agreement.trim().length >= 10

  return <AdminModal open={open} title="Resolver diferencia" description="Para cuando no podés enviar todo lo pedido. Queda registrado quién lo resolvió, qué cambió y la diferencia de dinero." onClose={onClose}
    footer={<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <AdminButton className="h-11" onClick={onClose}>Cancelar</AdminButton>
      <AdminPrimaryButton className="h-11" disabled={busy || !valid || !line} onClick={() => line && onSubmit({ orderItemId: line.order_item_id, quantity: value, problem, settlement, agreement: agreement.trim() })}>Registrar diferencia</AdminPrimaryButton>
    </div>}>
    {!line ? <p className="text-sm text-white/70">Todos los productos ya están pickeados: no hay diferencias para resolver.</p> : <div className="space-y-3">
      <AdminSelect title="Problema" value={problem} onChange={(next) => setProblem(next as DispatchAdjustmentProblem)}>
        {Object.entries(DISPATCH_ADJUSTMENT_PROBLEMS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </AdminSelect>
      <AdminSelect title="Producto" value={String(line.order_item_id)} onChange={(next) => { setItemId(next); setQuantity("") }}>
        {pending.map((item) => <option key={item.order_item_id} value={String(item.order_item_id)}>{`${item.name} · ${item.scanned_quantity} de ${item.expected_quantity}`}</option>)}
      </AdminSelect>
      <label className="block text-xs font-bold text-white/70">
        Unidades que salen
        <input aria-label="Unidades que salen" inputMode="numeric" value={quantity === "" ? String(value) : quantity}
          onChange={(event) => setQuantity(event.target.value.replace(/\D/g, "").slice(0, 4))}
          className="admin-control-input admin-ds-control mt-1 h-12 w-full px-3 text-lg font-black text-white outline-none" />
        <span className="mt-1 block font-normal text-white/55">Entre {line.scanned_quantity} (ya pickeadas) y {line.expected_quantity - 1}. Pedidas: {line.expected_quantity}.</span>
      </label>
      {validQuantity && <p role="status" className="rounded-lg bg-amber-950/60 px-3 py-2 text-sm font-bold text-amber-100">
        No salen {missing} {missing === 1 ? "unidad" : "unidades"}{line.unitPrice != null ? ` · Diferencia: ${money(line.unitPrice * missing)}` : ""}
      </p>}
      <AdminSelect title="Resolución acordada" value={settlement} onChange={(next) => setSettlement(next as DispatchAdjustmentSettlement)}>
        {Object.entries(DISPATCH_ADJUSTMENT_SETTLEMENTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </AdminSelect>
      <AdminTextarea title="Acuerdo con el cliente" value={agreement} onChange={setAgreement} rows={3} maxLength={1000} placeholder="Ej.: El cliente acepta 2 unidades y se le reintegra la restante." />
      <p className="text-xs text-white/55">El dinero no se mueve automáticamente: el reintegro o el saldo a favor se gestionan después desde Pedidos.</p>
      {error && <p role="alert" className="text-sm font-bold text-red-300">{error}</p>}
    </div>}
  </AdminModal>
}
