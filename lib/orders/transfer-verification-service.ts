import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import type { SupabasePedido } from "../supabase/types.ts"
import { appendOrderAuditEvent } from "./order-audit.ts"
import { expireTransferOrderIfNeeded } from "./transfer-expiration.ts"
import { searchIncomingBankTransfers } from "../mercadopago/bank-transfer-search.ts"
import type { MercadoPagoBankTransferCandidate } from "../mercadopago/bank-transfer-search.ts"
import {
  TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
  getTransferMatchWindow,
  matchBankTransferPayment,
  type TransferManualReviewReason,
} from "./transfer-auto-verification.ts"
import { normalizeDeclaredDni } from "../payments/argentine-identification.ts"
import { sendOrderStatusEmail } from "../email/send-order-status-email.ts"
import { moneyToCents } from "../mercadopago/order-payment.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export interface TransferVerificationDeclaredInput {
  firstName: string
  lastName: string
  dni: string
  amount: number
}

export type TransferVerificationAttemptResult =
  | { status: "verified"; order: SupabasePedido }
  | { status: "manual_review"; order: SupabasePedido; reason: TransferManualReviewReason }
  | { status: "rejected"; message: string }
  | { status: "rate_limited"; message: string }
  | { status: "checking_in_progress"; message: string }

const ELIGIBLE_PAYMENT_STATUSES = new Set(["pendiente_comprobante", "en_revision"])

const CLAIM_ERROR_MESSAGES: Record<string, string> = {
  ORDER_NOT_FOUND: "No encontramos el pedido.",
  NOT_TRANSFER_ORDER: "Este pedido no corresponde a transferencia bancaria.",
  ORDER_CANCELLED: "El pedido está cancelado.",
  ALREADY_RESOLVED: "El pago de este pedido ya fue resuelto.",
  MAX_ATTEMPTS_EXCEEDED:
    "Se alcanzó el máximo de intentos automáticos. Un administrador va a revisar tu transferencia.",
}

function extractErrorCode(message: string | undefined | null): string | null {
  if (!message) return null
  const match = /^([A-Z_]+):/.exec(message)
  return match ? match[1] : null
}

function firstRow<T>(data: T | T[] | null): T | null {
  if (!data) return null
  return Array.isArray(data) ? (data[0] ?? null) : data
}

async function persistDeclaredInput(
  admin: AdminClient,
  orderId: number,
  declared: TransferVerificationDeclaredInput,
  normalizedDni: string | null,
) {
  await admin
    .from("ordenes")
    .update({
      transfer_payer_first_name: declared.firstName.trim().slice(0, 200) || null,
      transfer_payer_last_name: declared.lastName.trim().slice(0, 200) || null,
      transfer_payer_dni: normalizedDni ?? (declared.dni.trim().slice(0, 20) || null),
      transfer_amount_declared: Number.isFinite(declared.amount) ? declared.amount : null,
    })
    .eq("id", orderId)
}

async function releaseVerificationLock(
  admin: AdminClient,
  orderId: number,
  fallbackStatus: "pending" | "manual_review",
  reason: TransferManualReviewReason | null,
) {
  await admin
    .from("ordenes")
    .update({
      transfer_verification_status: fallbackStatus,
      transfer_verification_failure_reason: reason,
    })
    .eq("id", orderId)
    .eq("transfer_verification_status", "checking")
}

async function finalizeManualReview(
  admin: AdminClient,
  orderId: number,
  reason: TransferManualReviewReason,
  fallbackOrder: SupabasePedido,
): Promise<TransferVerificationAttemptResult> {
  await releaseVerificationLock(admin, orderId, "manual_review", reason)
  const { data: refreshed } = await admin
    .from("ordenes")
    .select()
    .eq("id", orderId)
    .maybeSingle()

  return {
    status: "manual_review",
    reason,
    order: (refreshed as SupabasePedido) ?? fallbackOrder,
  }
}

/**
 * Intenta conciliar automáticamente UN pedido por transferencia contra
 * Mercado Pago. Usado tanto por el endpoint que dispara el cliente
 * ("Verificar transferencia") como por el cron de reintentos server-side --
 * ambos comparten esta única implementación para no duplicar la lógica de
 * matching ni de confirmación financiera.
 */
export interface TransferVerificationDependencies {
  /** Inyectable para tests -- por defecto llama a Mercado Pago de verdad. */
  searchTransfers?: (window: {
    beginDate: Date
    endDate: Date
  }) => Promise<MercadoPagoBankTransferCandidate[]>
}

export async function attemptTransferAutoVerification(
  admin: AdminClient,
  {
    orderId,
    declared,
  }: {
    orderId: number
    declared: TransferVerificationDeclaredInput
  },
  deps: TransferVerificationDependencies = {},
): Promise<TransferVerificationAttemptResult> {
  const searchTransfers = deps.searchTransfers ?? searchIncomingBankTransfers
  const { data: claimedData, error: claimError } = await admin.rpc(
    "claim_transfer_verification_attempt",
    { p_order_id: orderId },
  )

  if (claimError || !claimedData) {
    const code = extractErrorCode(claimError?.message)

    if (code === "RATE_LIMITED") {
      return {
        status: "rate_limited",
        message: "Esperá unos segundos antes de volver a intentar.",
      }
    }
    if (code === "ALREADY_CHECKING") {
      return {
        status: "checking_in_progress",
        message: "Ya estamos verificando tu transferencia.",
      }
    }

    return {
      status: "rejected",
      message: (code && CLAIM_ERROR_MESSAGES[code]) || "No se pudo iniciar la verificación.",
    }
  }

  const claimedOrder = firstRow<SupabasePedido>(claimedData)
  if (!claimedOrder) {
    return { status: "rejected", message: "No se pudo iniciar la verificación." }
  }

  const normalizedDni = normalizeDeclaredDni(declared.dni)
  await persistDeclaredInput(admin, orderId, declared, normalizedDni)

  const order = await expireTransferOrderIfNeeded(admin, claimedOrder)

  if (
    order.estado === "cancelado" ||
    !ELIGIBLE_PAYMENT_STATUSES.has(order.payment_status ?? "")
  ) {
    await releaseVerificationLock(admin, orderId, "pending", null)
    return {
      status: "rejected",
      message: "Tu pedido ya no admite verificación automática.",
    }
  }

  const expectedAmount = Number(order.external_amount_due ?? order.total ?? Number.NaN)
  const expectedCents = moneyToCents(expectedAmount)
  const declaredCents = moneyToCents(declared.amount)
  const normalizedDeclaredDniForFastPath = normalizeDeclaredDni(declared.dni)

  // Atajo sin llamar a Mercado Pago: si el monto o el DNI informados ya no
  // pueden coincidir con nada, no tiene sentido gastar una consulta a la API.
  if (
    expectedCents === null ||
    expectedCents <= 0 ||
    declaredCents === null ||
    declaredCents !== expectedCents
  ) {
    return finalizeManualReview(admin, orderId, "declared_amount_mismatch", order)
  }
  if (!normalizedDeclaredDniForFastPath) {
    return finalizeManualReview(admin, orderId, "declared_dni_invalid", order)
  }

  let candidates
  try {
    const { beginDate, endDate } = getTransferMatchWindow(order.created_at)
    candidates = await searchTransfers({ beginDate, endDate })
  } catch (error) {
    console.error("TRANSFER_AUTO_VERIFICATION_MP_SEARCH_ERROR", {
      orderId,
      message: error instanceof Error ? error.message : String(error),
    })
    return finalizeManualReview(admin, orderId, "mercadopago_unavailable", order)
  }

  const matchResult = matchBankTransferPayment({
    expectedAmount,
    declaredAmount: declared.amount,
    declaredDni: declared.dni,
    candidates,
  })

  if (matchResult.kind === "manual_review") {
    return finalizeManualReview(admin, orderId, matchResult.reason, order)
  }

  const { candidate, dniDerivation } = matchResult
  const { data: confirmedData, error: confirmError } = await admin.rpc(
    "confirm_transfer_auto_verification",
    {
      p_order_id: orderId,
      p_matched_payment_id: candidate.id,
      p_matched_operation_type: candidate.operationType,
      p_matched_payment_method_id: candidate.paymentMethodId,
      p_matched_amount: candidate.transactionAmount,
      p_matched_identification_type: candidate.identificationType,
      p_matched_identification_number: candidate.identificationNumber,
      p_matched_dni_derived: dniDerivation.dni,
      p_matched_bank_transfer_id: candidate.bankTransferId,
      p_matched_date_created: candidate.dateCreated,
      p_matched_date_approved: candidate.dateApproved,
    },
  )

  if (confirmError || !confirmedData) {
    const code = extractErrorCode(confirmError?.message)

    if (code === "TRANSFER_PAYMENT_ID_ALREADY_USED") {
      return finalizeManualReview(admin, orderId, "payment_id_already_used", order)
    }

    if (/checkout_stock_insufficient/i.test(confirmError?.message ?? "")) {
      await admin
        .from("ordenes")
        .update({
          payment_status: TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
          transfer_verification_status: "manual_review",
          transfer_verification_failure_reason: "stock_conflict",
        })
        .eq("id", orderId)

      await appendOrderAuditEvent(admin, {
        orderId,
        actorType: "system",
        action: "transfer_auto_verification_stock_conflict",
        previousStatus: order.financial_status ?? "pending_payment",
        newStatus: order.financial_status ?? "pending_payment",
        metadata: {
          matchedPaymentId: candidate.id,
          reason: "inventory_unavailable_at_confirmation",
        },
      })

      const { data: refreshed } = await admin
        .from("ordenes")
        .select()
        .eq("id", orderId)
        .maybeSingle()
      return {
        status: "manual_review",
        reason: "stock_conflict",
        order: (refreshed as SupabasePedido) ?? order,
      }
    }

    console.error("TRANSFER_AUTO_VERIFICATION_CONFIRM_ERROR", {
      orderId,
      message: confirmError?.message,
    })
    await releaseVerificationLock(admin, orderId, "pending", null)
    return {
      status: "rejected",
      message: "No se pudo confirmar la transferencia. Intentá nuevamente.",
    }
  }

  const confirmedOrder = firstRow<SupabasePedido>(confirmedData)!

  await sendOrderStatusEmail({
    to: confirmedOrder.cliente_email,
    subject: `Transferencia verificada BX-${1000 + confirmedOrder.id}`,
    html: `
      <h1>Transferencia verificada</h1>
      <p>Hola ${confirmedOrder.cliente_nombre ?? ""}, verificamos automáticamente tu transferencia del pedido BX-${1000 + confirmedOrder.id}.</p>
      <p>Tu compra ya está en preparación. Te avisaremos cuando sea despachada.</p>
    `,
  })

  return { status: "verified", order: confirmedOrder }
}
