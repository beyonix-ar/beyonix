export interface ReturnReviewPayload {
  receivedQuantity: number
  sellableQuantity: number
  discountedQuantity: number
  nonSellableQuantity: number
  discountPercent: number | null
  discountReason: string
  nonSellableReason: string
  notes: string
  occurredAt?: string | null
  expectedApprovedAt: string | null
  correctionReason?: string | null
}

export const ML_RETURN_CONFLICT_MESSAGE =
  "Esta devolución fue modificada por otro administrador. Recargá los datos antes de continuar."

export function buildReturnReviewRequest(saleId: string, payload: ReturnReviewPayload) {
  if (payload.expectedApprovedAt === undefined) throw new Error("Recargá la devolución antes de guardar.")
  if (payload.expectedApprovedAt && (payload.correctionReason?.trim().length ?? 0) < 3) {
    throw new Error("Indicá el motivo de la corrección (mínimo 3 caracteres).")
  }
  return {
    path: `/api/admin/mercadolibre-sales/${encodeURIComponent(saleId)}/return-review`,
    init: {
      method: "POST",
      body: JSON.stringify({ ...payload, correctionReason: payload.correctionReason?.trim() || null }),
    },
  }
}
