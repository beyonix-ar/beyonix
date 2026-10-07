import { isClaimFileSignatureMismatch } from "../order-claims.ts"
import { isSafeUploadedPdf } from "../security/uploaded-pdf.ts"

export async function isValidPaymentProofContent(bytes: Uint8Array, mimeType: string) {
  if (isClaimFileSignatureMismatch(bytes, mimeType)) return false
  return mimeType !== "application/pdf" || await isSafeUploadedPdf(bytes)
}
