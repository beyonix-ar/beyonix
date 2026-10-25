"use client"

import { useEffect, useState } from "react"
import { orderCode } from "@/lib/admin/dispatch"
import type { DispatchHistory } from "@/lib/admin/dispatch-history"
import { dispatchRequest } from "./dispatch-request"

const dateTime = (value: string | null) => {
  if (!value) return "—"
  const parts = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? ""
  return `${part("day")}/${part("month")}/${part("year")} - ${part("hour")}:${part("minute")}`
}

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
  // Orden real del proceso; el Despachador es quien confirmó el QR final (handed_over_by).
  const steps = [
    { label: "Picking", value: history.pickingBy.join(", ") || "Sin registro" },
    { label: "Armado del Bulto", value: history.assembledBy || "Sin registro" },
    { label: "Control del Bulto", value: history.controlledBy.join(", ") || "Sin registro" },
    { label: "Despachador", value: history.deliveredBy || "Sin registro" },
    { label: "Despachado", value: history.batch.handed_over_at ? dateTime(history.batch.handed_over_at) : "Pendiente" },
  ]
  return <div className="space-y-4 text-sm">
    <p>{history.orderCount} pedidos · {history.parcelCount} paquetes</p>
    <ol className="grid gap-1.5" aria-label="Responsables del despacho">
      {steps.map((step, index) => <li key={step.label} className="flex min-w-0 gap-2">
        <span className="shrink-0 font-black tabular-nums opacity-60">{index + 1}.</span>
        <span className="min-w-0"><strong>{step.label}:</strong> {step.value}</span>
      </li>)}
    </ol>
    <div className="overflow-x-auto"><table className="dispatch-orders-table w-full" aria-label="Pedidos del Bulto despachado"><thead><tr><th scope="col">Pedido</th><th scope="col">Estado</th><th scope="col">Paquetes</th><th scope="col">Preparó</th><th scope="col">Controló / retiró</th></tr></thead>
      <tbody>{history.items.map((item) => <tr key={item.orderId}><td><a href={`/admin/pedidos/${item.orderId}`} className="dispatch-delivered-order-link font-bold underline-offset-2 hover:underline">{orderCode(item.orderId)}</a></td><td title={item.removalReason || undefined}>{item.removedAt ? item.cancelled ? "Cancelado y retirado" : "Retirado" : "Despachado"}</td><td>{item.removedAt ? "—" : item.parcelCount}</td><td>{item.preparedBy || "—"}</td><td>{item.removedAt ? `${item.removedBy || "—"} · ${dateTime(item.removedAt)}` : item.controlledBy || "—"}</td></tr>)}</tbody>
    </table></div>
  </div>
}
