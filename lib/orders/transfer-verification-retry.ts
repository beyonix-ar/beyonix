import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import {
  attemptTransferAutoVerification,
  type TransferVerificationAttemptResult,
  type TransferVerificationDeclaredInput,
} from "./transfer-verification-service.ts"
import {
  getTransferMatchWindow,
  isRetryableManualReviewReason,
  type TransferManualReviewReason,
} from "./transfer-auto-verification.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/** Tope defensivo por corrida del cron -- mismo criterio que expireOverdueTransferOrders. */
const MAX_RETRY_CANDIDATES_PER_RUN = 25

const RETRY_LOAD_SELECT =
  "id, created_at, estado, payment_method_id, payment_status, payment_proof_url, payment_proof_uploaded_at, financial_status, transfer_verification_status, transfer_verification_failure_reason, transfer_verification_attempts, transfer_payer_first_name, transfer_payer_last_name, transfer_payer_dni, transfer_amount_declared"

interface RetryCandidateRow {
  id: number
  created_at: string
  payment_status: string | null
  transfer_verification_failure_reason: string | null
  transfer_payer_first_name: string | null
  transfer_payer_last_name: string | null
  transfer_payer_dni: string | null
  transfer_amount_declared: number | null
}

/**
 * Reintenta server-side la verificación automática de transferencias que
 * todavía no eran visibles en Mercado Pago (o que fallaron por una caída
 * transitoria de su API) en el último intento del cliente -- para no
 * depender de que el cliente deje la pestaña abierta. Nunca reintenta
 * motivos permanentes (DNI/monto que no coinciden, ambigüedad, etc.): eso
 * requiere corrección humana o del cliente, no tiempo.
 *
 * Corre completamente separado del cron de expiración de transferencias
 * (expireOverdueTransferOrders) y del de refunds de Mercado Pago: cada uno
 * tiene una única responsabilidad.
 */
export async function retryPendingTransferVerifications(
  admin: AdminClient,
  deps: {
    attempt?: (
      admin: AdminClient,
      args: { orderId: number; declared: TransferVerificationDeclaredInput },
    ) => Promise<TransferVerificationAttemptResult>
  } = {},
) {
  const attempt = deps.attempt ?? attemptTransferAutoVerification
  const nowIso = new Date().toISOString()

  const { data: candidates, error } = await admin
    .from("ordenes")
    .select(RETRY_LOAD_SELECT)
    .eq("payment_method_id", "transferencia")
    .in("payment_status", ["pendiente_comprobante", "en_revision"])
    .eq("transfer_verification_status", "manual_review")
    .not("transfer_amount_declared", "is", null)
    .not("transfer_payer_dni", "is", null)
    .neq("estado", "cancelado")
    .lte("created_at", nowIso)
    .order("transfer_last_verification_at", { ascending: true, nullsFirst: true })
    .limit(MAX_RETRY_CANDIDATES_PER_RUN)

  if (error) {
    console.warn("TRANSFER_VERIFICATION_RETRY_LOAD_ERROR", { message: error.message })
    return { attempted: 0, verified: 0 }
  }

  let attempted = 0
  let verified = 0

  for (const candidate of (candidates ?? []) as RetryCandidateRow[]) {
    const reason = candidate.transfer_verification_failure_reason as
      | TransferManualReviewReason
      | null

    if (!reason || !isRetryableManualReviewReason(reason)) continue

    const { endDate } = getTransferMatchWindow(candidate.created_at)
    if (endDate.getTime() < Date.now()) continue

    if (
      !candidate.transfer_payer_first_name ||
      !candidate.transfer_payer_last_name ||
      !candidate.transfer_payer_dni ||
      candidate.transfer_amount_declared === null
    ) {
      continue
    }

    attempted += 1

    const result = await attempt(admin, {
      orderId: candidate.id,
      declared: {
        firstName: candidate.transfer_payer_first_name,
        lastName: candidate.transfer_payer_last_name,
        dni: candidate.transfer_payer_dni,
        amount: candidate.transfer_amount_declared,
      },
    })

    if (result.status === "verified") verified += 1
  }

  return { attempted, verified }
}
