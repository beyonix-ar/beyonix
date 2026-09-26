import {
  validateTransferDeclaration,
  type TransferDeclaration,
  type TransferDeclarationField,
} from "../payments/transfer-declaration.ts"
import { isAwaitingTransferPayment } from "./transfer-verification-reasons.ts"

/**
 * Datos del titular que va a transferir, pedidos ANTES de mostrar alias/CVU.
 * El monto no lo informa el cliente: es el importe a transferir calculado por
 * el servidor al crear el pedido (external_amount_due, o total si no hubo
 * saldo a favor). Nombre y apellido quedan como evidencia para la
 * conciliación manual; el matching automático sigue siendo monto exacto +
 * DNI derivado del CUIT/CUIL + transferencia única + payment.id no usado.
 */
export interface TransferPayerOrderState {
  estado?: string | null
  payment_method_id?: string | null
  payment_status?: string | null
  payment_proof_url?: string | null
  payment_proof_uploaded_at?: string | null
  transfer_verification_status?: string | null
  external_amount_due?: number | string | null
  total?: number | string | null
}

export function getTransferAmountDue(order: Pick<TransferPayerOrderState, "external_amount_due" | "total">) {
  const amount = Number(order.external_amount_due ?? order.total)
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

export type TransferPayerDeclarationDecision =
  | { ok: true; value: TransferDeclaration }
  | { ok: false; reason: "not_transfer" | "not_editable" | "checking" | "invalid_amount" }
  | { ok: false; reason: "invalid_fields"; errors: Partial<Record<TransferDeclarationField, string>> }

export function decideTransferPayerDeclaration(
  order: TransferPayerOrderState,
  input: { nombre?: unknown; apellido?: unknown; dni?: unknown },
): TransferPayerDeclarationDecision {
  if (order.payment_method_id !== "transferencia") return { ok: false, reason: "not_transfer" }
  if (order.estado !== "pendiente" || !isAwaitingTransferPayment(order)) {
    return { ok: false, reason: "not_editable" }
  }
  // Una verificación en curso ya usa los datos guardados: no se pisan.
  if (order.transfer_verification_status === "checking") return { ok: false, reason: "checking" }

  const amount = getTransferAmountDue(order)
  if (amount === null) return { ok: false, reason: "invalid_amount" }

  const declaration = validateTransferDeclaration({ ...input, monto: amount })
  if (!declaration.ok) {
    const errors = { ...declaration.errors }
    delete errors.amount
    if (Object.keys(errors).length === 0) return { ok: false, reason: "invalid_amount" }
    return { ok: false, reason: "invalid_fields", errors }
  }
  return declaration
}
