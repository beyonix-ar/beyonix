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
  RETRYABLE_MANUAL_REVIEW_REASONS,
  type TransferManualReviewReason,
} from "./transfer-auto-verification.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/** Tope defensivo por corrida del cron -- mismo criterio que expireOverdueTransferOrders. */
const MAX_RETRY_CANDIDATES_PER_RUN = 25

/**
 * Presupuesto de tiempo de pared por corrida: deja margen bajo el
 * --max-time del curl que dispara este endpoint desde systemd (ver
 * deploy/systemd/beyonix-verify-transfer-orders.service) para que el
 * proceso del lado del servidor nunca siga corriendo mucho después de que
 * curl ya se dio por vencido. Cortar acá es sólo una salvaguarda de tiempo:
 * la protección real contra doble procesamiento sigue siendo el lease
 * "checking" de claim_transfer_verification_attempt (por pedido, bajo lock
 * en la base), que ya hace inofensivo cualquier solapamiento entre
 * corridas.
 */
const MAX_RETRY_RUN_DURATION_MS = 90_000

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
  const startedAt = Date.now()

  const { data: candidates, error } = await admin
    .from("ordenes")
    .select(RETRY_LOAD_SELECT)
    .eq("payment_method_id", "transferencia")
    .in("payment_status", ["pendiente_comprobante", "en_revision"])
    .eq("transfer_verification_status", "manual_review")
    // P1 (starvation del cron): filtrar por motivo reintentable ACÁ, en la
    // propia consulta SQL -- no sólo en JS más abajo. Antes, órdenes con un
    // motivo PERMANENTE (dni_mismatch, multiple_candidates, etc.) podían
    // ocupar los primeros N lugares del "order by ... asc" para siempre
    // (nunca se les vuelve a intentar, así que su transfer_last_verification_at
    // nunca avanza) y dejar sin turno a las que sí son reintentables. Con
    // este filtro, esas órdenes permanentes ni siquiera entran al batch.
    .in("transfer_verification_failure_reason", RETRYABLE_MANUAL_REVIEW_REASONS)
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
    if (Date.now() - startedAt > MAX_RETRY_RUN_DURATION_MS) {
      console.warn("TRANSFER_VERIFICATION_RETRY_TIME_BUDGET_EXCEEDED", {
        attempted,
        remaining: (candidates?.length ?? 0) - attempted,
      })
      break
    }

    // Defensa en profundidad: la consulta SQL ya filtra por motivo
    // reintentable, pero este chequeo se mantiene para no depender
    // únicamente de ese filtro (y sigue siendo necesario para el resto de
    // las validaciones que no pueden expresarse en la consulta, como la
    // ventana temporal y los datos declarados).
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
