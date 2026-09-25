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
  | "search_not_exhaustive"
  | "expected_amount_changed"
  | "confirmation_error"

/** payment_status cuando Mercado Pago confirmó la transferencia pero el stock ya no alcanza -- igual criterio que MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS para Checkout Pro: el dinero es real, la orden NO se confirma ni se cancela sola, requiere resolución humana. */
export const TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS = "auto_verified_stock_conflict"

/**
 * Motivos que sí pueden cambiar solos con el paso del tiempo: la
 * transferencia todavía no era visible en Mercado Pago, la API falló de
 * forma transitoria, o la transferencia ya coincidió (monto + DNI) pero la
 * confirmación falló por un error no tipificado. Fuente única de verdad para el cron de reintentos
 * (lib/orders/transfer-verification-retry.ts) -- la consulta SQL filtra por
 * esta misma lista para no traer nunca motivos permanentes (evita que
 * pedidos con un motivo no reintentable "envenenen" el batch del cron y
 * dejen sin turno a los que sí son reintentables).
 */
export const RETRYABLE_MANUAL_REVIEW_REASONS: readonly TransferManualReviewReason[] = [
  "no_candidates",
  "mercadopago_unavailable",
  "confirmation_error",
]

export function isRetryableManualReviewReason(
  reason: TransferManualReviewReason,
): boolean {
  return (RETRYABLE_MANUAL_REVIEW_REASONS as readonly string[]).includes(reason)
}

/**
 * Único criterio de "¿este pedido por transferencia puede recibir un
 * comprobante para revisión manual ahora mismo?" -- fuente única de verdad
 * compartida por el endpoint de verificación automática
 * (app/api/transferencia/[orderId]/verificar/route.ts), el endpoint que
 * recibe el comprobante (app/api/payment-proofs/route.ts) y los componentes
 * de UI (customer-payment-proof.tsx, components/checkout/transfer-flow.tsx).
 * Antes cada uno mantenía su propia lista hardcodeada, y podían quedar
 * inconsistentes entre sí (ej.: auto_verified_stock_conflict mostraba el
 * uploader en la UI pero el backend respondía 409). Regla general: mientras
 * el pago NO esté confirmado y no haya sido rechazado sin vía de corrección,
 * el cliente siempre puede subir un comprobante como respaldo -- incluida
 * una transferencia ya identificada en Mercado Pago pero bloqueada por
 * conflicto de stock (el dinero es real, un admin puede necesitar ese
 * comprobante adicional antes de resolver manualmente).
 */
export const TRANSFER_PROOF_UPLOAD_ELIGIBLE_PAYMENT_STATUSES = [
  "pendiente_comprobante",
  "en_revision",
  "rechazado",
  TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
] as const

export function canUploadTransferProof(
  paymentStatus: string | null | undefined,
): boolean {
  const status = paymentStatus || "pendiente_comprobante"
  return (TRANSFER_PROOF_UPLOAD_ELIGIBLE_PAYMENT_STATUSES as readonly string[]).includes(
    status,
  )
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
    case "search_not_exhaustive":
      return "No se pudo recorrer todo el historial de Mercado Pago dentro de la ventana de tiempo: requiere revisión manual antes de confirmar."
    case "expected_amount_changed":
      return "El monto esperado del pedido cambió mientras se verificaba la transferencia. Requiere revisión manual."
    case "confirmation_error":
      return "La transferencia coincidió (monto y DNI), pero la confirmación falló por un error temporal. Se reintenta automáticamente."
    case null:
      return "Sin intentos de verificación registrados."
    default:
      return "Motivo de revisión manual desconocido."
  }
}
