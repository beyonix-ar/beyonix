"use client"

import { useEffect, useState } from "react"
import { orderCode } from "@/lib/admin/dispatch"
import { dispatchBatchName } from "@/lib/admin/dispatch-queue"
import type { DispatchHistory } from "@/lib/admin/dispatch-history"
import { dispatchRequest } from "./dispatch-request"

const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"

export function DeliveredBatchPanel({ batchId }: { batchId: number }) {
  const [history, setHistory] = useState<DispatchHistory | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    let active = true
    void dispatchRequest<DispatchHistory>(`/batches/${batchId}?history`).then((value) => { if (active) setHistory(value) })
      .catch(() => { if (active) setError("No se pudo cargar el historial del Bulto.") })
    return () => { active = false }
  }, [batchId])
  if (error) return <p role="alert" className="text-sm text-red-300">{error}</p>
  if (!history) return <p role="status" className="text-sm">Cargando historial…</p>
  return <div className="space-y-4 text-sm">
    <div className="dispatch-delivered-summary">
      <strong>{dispatchBatchName(history.batch)}</strong><span>Entregado: {dateTime(history.batch.handed_over_at)}</span>
      <span>{history.orderCount} pedidos · {history.parcelCount} paquetes</span>
      <span>Preparó: {history.preparedBy.join(", ") || "Sin registro"}</span>
      <span>Armó: {history.assembledBy || "Sin registro"}</span>
      <span>Controló: {history.controlledBy.join(", ") || "Sin registro"}</span>
      <span>Confirmó entrega: {history.deliveredBy || "Sin registro"}</span>
    </div>
    <div className="overflow-x-auto"><table className="dispatch-orders-table w-full" aria-label="Pedidos del Bulto entregado"><thead><tr><th scope="col">Pedido</th><th scope="col">Estado</th><th scope="col">Paquetes</th><th scope="col">Preparó</th><th scope="col">Controló / retiró</th></tr></thead>
      <tbody>{history.items.map((item) => <tr key={item.orderId}><td>{orderCode(item.orderId)}</td><td title={item.removalReason || undefined}>{item.removedAt ? item.cancelled ? "Cancelado y retirado" : "Retirado" : "Entregado"}</td><td>{item.removedAt ? "—" : item.parcelCount}</td><td>{item.preparedBy || "—"}</td><td>{item.removedAt ? `${item.removedBy || "—"} · ${dateTime(item.removedAt)}` : item.controlledBy || "—"}</td></tr>)}</tbody>
    </table></div>
  </div>
}
