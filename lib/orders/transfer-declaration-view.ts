import { formatDeclaredPayerDocument } from "../payments/argentine-identification.ts"
import { getTransferVerificationStatusLabel } from "./transfer-verification-reasons.ts"

/**
 * Vista para Admin > Pedido > Pago > "Datos de la transferencia": lo que el
 * cliente declaró sobre el TITULAR de la cuenta desde donde salió el dinero,
 * más el estado de verificación y el comprobante. Pura y sin fetch: el
 * comprobante se abre SIEMPRE por el endpoint admin con URL firmada
 * (/api/admin/payment-proofs/[orderId]), nunca con la ruta de Storage.
 * Pedidos históricos sin estos datos muestran "No informado".
 */

export const TRANSFER_DECLARATION_MISSING = "No informado"

export interface TransferDeclarationViewOrder {
  transfer_payer_first_name?: string | null
  transfer_payer_last_name?: string | null
  transfer_payer_dni?: string | null
  transfer_amount_declared?: number | string | null
  transfer_last_verification_at?: string | null
  transfer_verification_status?: string | null
  transfer_verification_attempts?: number | null
  payment_proof_url?: string | null
  payment_proof_file_name?: string | null
  payment_proof_uploaded_at?: string | null
}

export interface TransferDeclarationView {
  hasDeclaration: boolean
  firstName: string
  lastName: string
  document: string
  declaredAmount: number | null
  /** Fecha/hora de la última carga de datos (último intento de verificación). */
  declaredAt: string | null
  verificationLabel: string
  proof: {
    attached: boolean
    fileName: string
    uploadedAt: string | null
  }
}

function text(value: string | null | undefined) {
  return value?.trim() || null
}

export function getTransferDeclarationView(order: TransferDeclarationViewOrder): TransferDeclarationView {
  const firstName = text(order.transfer_payer_first_name)
  const lastName = text(order.transfer_payer_last_name)
  const document = formatDeclaredPayerDocument(order.transfer_payer_dni)
  const rawAmount =
    order.transfer_amount_declared == null ? Number.NaN : Number(order.transfer_amount_declared)
  const declaredAmount = Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : null
  const hasDeclaration = Boolean(firstName || lastName || document || declaredAmount != null)
  const attached = Boolean(order.payment_proof_url)

  return {
    hasDeclaration,
    firstName: firstName ?? TRANSFER_DECLARATION_MISSING,
    lastName: lastName ?? TRANSFER_DECLARATION_MISSING,
    document: document ?? TRANSFER_DECLARATION_MISSING,
    declaredAmount,
    declaredAt: hasDeclaration ? (order.transfer_last_verification_at ?? null) : null,
    verificationLabel: getTransferVerificationStatusLabel(
      order.transfer_verification_status,
      order.transfer_verification_attempts ?? (hasDeclaration ? 1 : 0),
    ),
    proof: {
      attached,
      fileName: attached
        ? text(order.payment_proof_file_name) ?? "Comprobante adjunto"
        : "Sin comprobante adjunto",
      uploadedAt: attached ? (order.payment_proof_uploaded_at ?? null) : null,
    },
  }
}
