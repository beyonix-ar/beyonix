"use client"

import { useState } from "react"
import { CheckCircle2, Circle, PackageOpen } from "lucide-react"

import { orderCode } from "@/lib/admin/dispatch"
import { formatLocalDeliveryDeadline, type LocalDeliveryReturnParcel } from "@/lib/shipping/local-delivery-outcome"
import { dispatchRequest } from "./dispatch-request"
import { ScanField } from "./scan-field"

export interface LocalDeliveryReturnOrder {
  id: number
  cliente_nombre: string | null
  returnParcels: LocalDeliveryReturnParcel[]
}

interface ReceiveResult {
  orderId: number
  code: string
  received: number
  parcelCount: number
  complete: boolean
  completedNow: boolean
  duplicate: boolean
  reservationExpiresAt: string | null
}

/**
 * Recibir devolución local (picking inverso): pedidos Envío BEYONIX que
 * regresan a BEYONIX. Se escanea cada BX-PKG que trae el cadete; hasta que
 * vuelven TODOS el pedido no queda "Devuelto a BEYONIX" ni empieza la reserva.
 * Retorno logístico: no es una devolución comercial ni pasa por Andreani.
 */
export function LocalDeliveryReturns({ orders, onChanged, onCompleted }: {
  orders: LocalDeliveryReturnOrder[]
  onChanged: () => Promise<void>
  /** Recepción completa: el pedido sale de esta lista, el aviso queda en el panel. */
  onCompleted: (message: string) => void
}) {
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null)

  async function scan(value: string) {
    if (busy) return
    setBusy(true)
    setFeedback(null)
    try {
      const result = await dispatchRequest<ReceiveResult>("/local/returns", { code: value })
      const order = orderCode(result.orderId)
      const message = result.completedNow
        ? `${order}: Devuelto a BEYONIX. ${result.reservationExpiresAt ? `Reserva activa hasta ${formatLocalDeliveryDeadline(result.reservationExpiresAt)}.` : "Sin reserva (pedido cancelado)."}`
        : result.duplicate
          ? `${result.code} ya estaba recibido · ${order}: ${result.received} de ${result.parcelCount} bultos.`
          : result.complete
            ? `${order}: todos los bultos recibidos.`
            : `${result.code} recibido · ${order}: Recepción incompleta — ${result.received} de ${result.parcelCount} bultos.`
      setFeedback({ tone: "success", message })
      if (result.completedNow) onCompleted(message)
      setCode("")
      await onChanged()
    } catch (cause) {
      setFeedback({ tone: "error", message: cause instanceof Error ? cause.message : "No se pudo registrar el bulto." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/5 p-3" data-local-delivery-returns="">
      <p className="flex items-center gap-2 text-sm font-black text-white">
        <PackageOpen className="size-4" />Recibir devolución local
      </p>
      <p className="mt-0.5 text-xs text-white/70">
        Escaneá cada BX-PKG que vuelve. El pedido queda Devuelto a BEYONIX recién con todos sus bultos.
      </p>
      <div className="mt-2">
        <ScanField
          label="Código BX-PKG del bulto que vuelve"
          placeholder="Escaneá el BX-PKG"
          submitLabel="Recibir bulto"
          value={code}
          onChange={setCode}
          onScan={(value) => void scan(value)}
          busy={busy}
          cameraTitle="Recibir devolución local"
          cameraHint="Apuntá a la etiqueta BX-PKG del bulto"
          feedback={feedback}
        />
      </div>
      {feedback && (
        <p role={feedback.tone === "error" ? "alert" : "status"} data-local-return-feedback={feedback.tone}
          className={`mt-2 text-sm font-bold ${feedback.tone === "error" ? "text-red-200" : "text-emerald-200"}`}>
          {feedback.message}
        </p>
      )}
      <ul className="mt-2 space-y-2">
        {orders.map((order) => {
          const received = order.returnParcels.filter((parcel) => parcel.received).length
          const total = order.returnParcels.length
          return (
            <li key={order.id} className="rounded-lg border border-white/10 bg-black/20 p-2" data-local-return-order={order.id}>
              <p className="text-sm font-black text-white">
                {orderCode(order.id)} <span className="font-semibold text-white/70">· {order.cliente_nombre ?? "—"}</span>
              </p>
              <p className="text-xs font-bold text-amber-200" data-local-return-progress={`${received}/${total}`}>
                {received < total ? `Recepción incompleta · ${received} de ${total} bultos recibidos` : `${total} de ${total} bultos recibidos`}
              </p>
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {order.returnParcels.map((parcel) => (
                  <li key={parcel.barcode} className="flex items-center gap-1 text-xs tabular-nums text-white/85" data-local-return-parcel={parcel.barcode} data-received={parcel.received ? "yes" : "no"}>
                    {parcel.received ? <CheckCircle2 className="size-3.5 text-emerald-300" /> : <Circle className="size-3.5 text-white/40" />}
                    {parcel.barcode}
                  </li>
                ))}
              </ul>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

