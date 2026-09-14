/**
 * Subconjunto client-safe de lib/orders/transfer-auto-verification.ts: sólo
 * tipos y funciones puras de presentación, sin ninguna dependencia
 * transitiva de módulos "server-only" (transfer-expiration.ts sí lo es, por
 * eso este archivo NO lo importa). Import seguro desde componentes cliente
 * del panel admin.
 */

export type TransferManualReviewReason =
  | "declared_amount_mismatch"
  | "declared_dni_invalid"
  | "no_candidates"
  | "amount_mismatch_mp"
  | "multiple_candidates"
  | "identification_unavailable"
  | "dni_mismatch"
  | "payment_id_already_used"
  | "mercadopago_unavailable"
  | "stock_conflict"

/** payment_status cuando Mercado Pago confirmó la transferencia pero el stock ya no alcanza -- igual criterio que MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS para Checkout Pro: el dinero es real, la orden NO se confirma ni se cancela sola, requiere resolución humana. */
export const TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS = "auto_verified_stock_conflict"

/**
 * Reintentar automáticamente sólo tiene sentido cuando la transferencia
 * simplemente todavía no es visible en Mercado Pago -- el resto de los
 * motivos no cambian solos con el paso del tiempo.
 */
export function isRetryableManualReviewReason(
  reason: TransferManualReviewReason,
): boolean {
  return reason === "no_candidates" || reason === "mercadopago_unavailable"
}

/** Copy segura y genérica para el cliente -- nunca expone datos de Mercado Pago ni de otros pedidos. */
export function getManualReviewCustomerMessage(): string {
  return "No pudimos validar tu transferencia automáticamente."
}

/** Motivo técnico legible para el panel admin -- no expone PII de terceros. */
export function describeManualReviewReason(
  reason: TransferManualReviewReason | string | null,
): string {
  switch (reason) {
    case "declared_amount_mismatch":
      return "El monto informado no coincide con el monto esperado del pedido."
    case "declared_dni_invalid":
      return "El DNI informado por el cliente no tiene un formato válido."
    case "no_candidates":
      return "Todavía no encontramos ninguna transferencia con ese monto en Mercado Pago."
    case "amount_mismatch_mp":
      return "Encontramos transferencias en la ventana de tiempo, pero ninguna con el monto exacto esperado."
    case "multiple_candidates":
      return "Encontramos más de una transferencia posible con el mismo monto: requiere revisión manual."
    case "identification_unavailable":
      return "Mercado Pago no informó un documento válido del pagador para esa transferencia."
    case "dni_mismatch":
      return "El documento derivado de Mercado Pago no coincide con el DNI informado por el cliente."
    case "payment_id_already_used":
      return "Esa transferencia ya fue utilizada para acreditar otro pedido."
    case "mercadopago_unavailable":
      return "Mercado Pago no respondió a tiempo durante la verificación."
    case "stock_conflict":
      return "Mercado Pago aprobó el pago, pero el stock ya no alcanza para este pedido. Requiere resolución manual."
    case null:
      return "Sin intentos de verificación registrados."
    default:
      return "Motivo de revisión manual desconocido."
  }
}
