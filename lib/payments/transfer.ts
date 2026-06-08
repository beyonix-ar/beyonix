export const TRANSFER_ALIAS = "beyonix"
export const TRANSFER_DISCOUNT_PERCENT = 5
export const PAYMENT_PROOF_BUCKET = "payment-proofs"
export const PAYMENT_PROOF_MAX_SIZE = 5 * 1024 * 1024

export const PAYMENT_PROOF_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]

export const PAYMENT_PROOF_ALLOWED_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "pdf",
]

export function calculateTransferDiscount(total: number) {
  const safeTotal = Number.isFinite(total) ? Math.max(total, 0) : 0

  return Math.round(safeTotal * (TRANSFER_DISCOUNT_PERCENT / 100))
}

export function getPaymentProofValidationError(file: File | null) {
  if (!file) return "Seleccioná un archivo para subir."

  const extension = file.name.split(".").pop()?.toLowerCase() ?? ""
  const validType = PAYMENT_PROOF_ALLOWED_TYPES.includes(file.type)
  const validExtension = PAYMENT_PROOF_ALLOWED_EXTENSIONS.includes(extension)

  if (!validType || !validExtension) {
    return "El comprobante debe ser JPG, PNG, WEBP o PDF."
  }

  if (file.size > PAYMENT_PROOF_MAX_SIZE) {
    return "El comprobante no puede superar los 5 MB."
  }

  return ""
}

export function sanitizePaymentProofFileName(fileName: string) {
  const fallback = "comprobante"
  const safeName =
    fileName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || fallback

  return safeName.slice(0, 120)
}
