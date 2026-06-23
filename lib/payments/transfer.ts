import { TRANSFER_DISCOUNT } from "@/lib/store-config"

export const TRANSFER_ALIAS = "beyonix"
export const TRANSFER_ACCOUNT_HOLDER = "Lucas Espinosa"
export const TRANSFER_CVU = "0000003100060656803844"
export const TRANSFER_DISCOUNT_PERCENT = TRANSFER_DISCOUNT * 100
export const PAYMENT_PROOF_BUCKET = "payment-proofs"
export const PAYMENT_PROOF_MAX_SIZE = 5 * 1024 * 1024

export const PAYMENT_PROOF_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
]

export const PAYMENT_PROOF_ALLOWED_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "pdf",
]

export function calculateTransferDiscount(productsTotal: number) {
  const safeProductsTotal = Number.isFinite(productsTotal)
    ? Math.max(productsTotal, 0)
    : 0

  return Math.round(
    safeProductsTotal * TRANSFER_DISCOUNT,
  )
}

export function calculateTransferPaymentTotal(
  productsTotal: number,
  shipping: number,
) {
  const safeProductsTotal = Number.isFinite(productsTotal)
    ? Math.max(productsTotal, 0)
    : 0
  const safeShipping = Number.isFinite(shipping) ? Math.max(shipping, 0) : 0
  const discount = calculateTransferDiscount(safeProductsTotal)

  return {
    discount,
    total: Math.max(safeProductsTotal - discount + safeShipping, 0),
  }
}

export function getPaymentProofValidationError(file: File | null) {
  if (!file) return "Seleccioná un archivo para subir."

  const extension = file.name.split(".").pop()?.toLowerCase() ?? ""
  const validType = PAYMENT_PROOF_ALLOWED_TYPES.includes(file.type)
  const validExtension = PAYMENT_PROOF_ALLOWED_EXTENSIONS.includes(extension)

  if (!validType || !validExtension) {
    return "El comprobante debe ser JPG, JPEG, PNG o PDF."
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
