import { TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS } from "./transfer-verification-reasons.ts"

export const TRANSFER_PAYMENT_STATUSES = [
  "pendiente_comprobante",
  "en_revision",
  "confirmado",
  "rechazado",
] as const

export type TransferPaymentStatus = (typeof TRANSFER_PAYMENT_STATUSES)[number]

interface TransferPaymentTransitionInput {
  currentStatus: string | null | undefined
  nextStatus: string
  hasProof: boolean
  observation?: string | null
}

export function getTransferPaymentTransitionError({
  currentStatus,
  nextStatus,
  hasProof,
  observation,
}: TransferPaymentTransitionInput): string | null {
  const current = currentStatus || "pendiente_comprobante"

  if (!(TRANSFER_PAYMENT_STATUSES as readonly string[]).includes(nextStatus)) {
    return "Estado de pago inválido."
  }

  if (nextStatus === current) return null

  if (current === "confirmado") {
    return "Un pago confirmado no puede volver a un estado anterior."
  }

  // La transferencia ya fue identificada y reclamada contra Mercado Pago
  // (confirm_transfer_auto_verification, migración 20260914090000), pero el
  // guardián de inventario rechazó la confirmación por falta de stock. El
  // dinero ya es real: un admin puede confirmar (si repuso stock) o
  // rechazar directamente desde acá, sin depender de que el cliente suba un
  // comprobante -- ya no hace falta, la plata ya está identificada. Mismo
  // mecanismo (este endpoint, esta función) que la aprobación manual
  // existente, nunca un segundo sistema de resolución.
  if (current === TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS) {
    if (nextStatus !== "confirmado" && nextStatus !== "rechazado") {
      return "Esta transferencia ya fue identificada en Mercado Pago: sólo puede confirmarse o rechazarse."
    }
    if (nextStatus === "rechazado" && (observation?.trim().length ?? 0) < 3) {
      return "Indicá el motivo del rechazo."
    }
    return null
  }

  if (nextStatus !== "confirmado" && nextStatus !== "rechazado") {
    return "La revisión comienza cuando el cliente carga o reemplaza el comprobante."
  }

  if (current !== "en_revision" || !hasProof) {
    return "Solo se puede confirmar o rechazar un comprobante que esté en revisión."
  }

  if (nextStatus === "rechazado" && (observation?.trim().length ?? 0) < 3) {
    return "Indicá el motivo del rechazo del comprobante."
  }

  return null
}

export function getAllowedAdminTransferPaymentStatuses(
  currentStatus: string | null | undefined,
  hasProof: boolean,
): TransferPaymentStatus[] {
  if (currentStatus === TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS) {
    return ["confirmado", "rechazado"]
  }

  const current = (TRANSFER_PAYMENT_STATUSES as readonly string[]).includes(
    currentStatus ?? "",
  )
    ? (currentStatus as TransferPaymentStatus)
    : "pendiente_comprobante"

  if (current === "en_revision" && hasProof) {
    return ["en_revision", "confirmado", "rechazado"]
  }

  return [current]
}
