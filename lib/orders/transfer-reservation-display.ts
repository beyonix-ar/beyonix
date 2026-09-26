import { isAwaitingTransferPayment } from "./transfer-verification-reasons.ts"

/**
 * Estado de la reserva de un pedido por transferencia en "Mis compras".
 * Sólo presentación: la fuente de verdad es el expires_at original que
 * adjunta el servidor (attachTransferReservationDeadlines). Sin reserva
 * registrada se muestra vencida: nunca se sugiere stock garantizado de más.
 */
export type CustomerTransferReservationState =
  | { kind: "none" }
  | { kind: "active"; expiresAt: string; secondsLeft: number }
  | { kind: "expired" }

export function getCustomerTransferReservationState(
  order: {
    estado?: string | null
    payment_method_id?: string | null
    payment_status?: string | null
    payment_proof_url?: string | null
    payment_proof_uploaded_at?: string | null
    transfer_reservation_expires_at?: string | null
  },
  nowMs: number,
): CustomerTransferReservationState {
  if (order.payment_method_id !== "transferencia" || order.estado !== "pendiente") return { kind: "none" }
  if (!isAwaitingTransferPayment(order)) return { kind: "none" }
  const expiresAt = order.transfer_reservation_expires_at
  const expiresMs = expiresAt ? Date.parse(expiresAt) : Number.NaN
  if (!expiresAt || !Number.isFinite(expiresMs) || expiresMs <= nowMs) return { kind: "expired" }
  return { kind: "active", expiresAt, secondsLeft: Math.ceil((expiresMs - nowMs) / 1000) }
}

export function formatReservationDeadline(expiresAt: string) {
  return new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(expiresAt))
}
