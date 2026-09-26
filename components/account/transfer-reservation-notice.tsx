"use client"

import { useEffect, useState } from "react"
import { Clock, TimerOff } from "lucide-react"

import { formatReservationCountdown } from "@/lib/cart/checkout-step-reservation"
import {
  formatReservationDeadline,
  getCustomerTransferReservationState,
} from "@/lib/orders/transfer-reservation-display"
import type { CustomerOrderSummary } from "@/lib/supabase/types"

type ReservationOrder = Pick<
  CustomerOrderSummary,
  "estado" | "payment_method_id" | "payment_status" | "payment_proof_url" | "payment_proof_uploaded_at" | "transfer_reservation_expires_at"
>

/**
 * "Mis compras": cuánto le queda a la reserva de un pedido por transferencia
 * pendiente, o que ya venció. Usa la hora del servidor (no el reloj del
 * dispositivo) y nunca abre ni renueva una reserva: un intento nuevo sale
 * siempre del carrito/checkout.
 */
export function TransferReservationNotice({
  order,
  serverNow,
  className = "",
}: {
  order: ReservationOrder
  serverNow: string | null
  className?: string
}) {
  const serverNowMs = serverNow ? Date.parse(serverNow) : Number.NaN
  const [nowMs, setNowMs] = useState(serverNowMs)

  useEffect(() => {
    if (!Number.isFinite(serverNowMs)) return
    const offset = serverNowMs - Date.now()
    const tick = () => setNowMs(Date.now() + offset)
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [serverNowMs])

  // Sin hora del servidor no se puede afirmar que la reserva siga vigente.
  const state = getCustomerTransferReservationState(order, Number.isFinite(nowMs) ? nowMs : Number.POSITIVE_INFINITY)
  if (state.kind === "none") return null

  if (state.kind === "active") {
    return (
      <div
        data-transfer-reservation="active"
        className={`flex items-start gap-2.5 rounded-xl border border-[var(--account-info-border)] bg-[var(--account-info-bg)] px-3.5 py-2.5 text-left ${className}`}
      >
        <Clock className="mt-0.5 size-4 shrink-0 text-[var(--account-info-text)]" aria-hidden="true" />
        <p className="text-xs leading-5 text-[var(--account-info-text)]">
          <strong className="font-bold">
            Pago pendiente · stock reservado hasta las {formatReservationDeadline(state.expiresAt)}
          </strong>{" "}
          (quedan <span className="tabular-nums">{formatReservationCountdown(state.secondsLeft)}</span>). Pasado ese
          horario la reserva se libera y el stock deja de estar garantizado.
        </p>
      </div>
    )
  }

  return (
    <div
      data-transfer-reservation="expired"
      role="status"
      className={`flex items-start gap-2.5 rounded-xl border border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] px-3.5 py-2.5 text-left ${className}`}
    >
      <TimerOff className="mt-0.5 size-4 shrink-0 text-[var(--account-warning)]" aria-hidden="true" />
      <p className="text-xs leading-5 text-[var(--account-text-primary)]">
        <strong className="font-bold">Reserva vencida.</strong> Pasaron los 20 minutos para pagar y el stock ya
        no está reservado. Si todavía querés estos productos, iniciá una compra nueva desde tu carrito.
      </p>
    </div>
  )
}
