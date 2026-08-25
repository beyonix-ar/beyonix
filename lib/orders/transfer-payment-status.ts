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
