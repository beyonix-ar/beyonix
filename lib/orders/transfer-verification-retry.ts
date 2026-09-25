import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import {
  attemptTransferAutoVerification,
  type TransferVerificationAttemptResult,
  type TransferVerificationDeclaredInput,
} from "./transfer-verification-service.ts"
import {
  AWAITING_TRANSFER_REASONS,
  getTransferAutoRetryIntervalMs,
  isAwaitingTransferReason,
  isRetryableManualReviewReason,
  isTransferAutoRetryDue,
  RETRYABLE_MANUAL_REVIEW_REASONS,
  TRANSFER_AUTO_RETRY_GRACE_MINUTES,
  TRANSFER_AUTO_RETRY_SCHEDULE,
  TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS,
  type TransferManualReviewReason,
} from "./transfer-auto-verification.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Espera normal, revisión manual que puede resolverse con el tiempo, o
 * pending sin motivo tras un intento (fallo de confirmación anterior).
 */
const RETRY_CANDIDATE_FILTER =
  `and(transfer_verification_status.eq.pending,or(transfer_verification_failure_reason.in.(${AWAITING_TRANSFER_REASONS.join(",")}),and(transfer_verification_failure_reason.is.null,transfer_verification_attempts.gt.0))),` +
  `and(transfer_verification_status.eq.manual_review,transfer_verification_failure_reason.in.(${RETRYABLE_MANUAL_REVIEW_REASONS.join(",")}))`

function isRetryCandidate(status: string | null, reason: TransferManualReviewReason | null, attempts: number | null) {
  if (status === "manual_review") return reason !== null && isRetryableManualReviewReason(reason)
  return status === "pending" && (reason === null ? (attempts ?? 0) > 0 : isAwaitingTransferReason(reason))
}

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

const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

const RETRY_LOAD_SELECT =
  "id, created_at, estado, payment_method_id, payment_status, payment_proof_url, payment_proof_uploaded_at, financial_status, transfer_verification_status, transfer_verification_failure_reason, transfer_verification_attempts, transfer_last_verification_at, transfer_payer_first_name, transfer_payer_last_name, transfer_payer_dni, transfer_amount_declared"

interface RetryCandidateRow {
  id: number
  created_at: string
  payment_status: string | null
  transfer_verification_status: string | null
  transfer_verification_failure_reason: string | null
  transfer_verification_attempts: number | null
  transfer_last_verification_at: string | null
  transfer_payer_first_name: string | null
  transfer_payer_last_name: string | null
  transfer_payer_dni: string | null
  transfer_amount_declared: number | null
}

/**
 * Reintenta server-side la verificación automática de transferencias que
 * todavía no aparecían en Mercado Pago (o que fallaron por una caída
 * transitoria de su API) -- para no depender de que el cliente deje la
 * pestaña abierta ni de que vuelva a verificar. Cubre TODA la ventana de
 * conciliación de 48 h con el calendario de TRANSFER_AUTO_RETRY_SCHEDULE
 * (frecuente al principio, más espaciado después); ya no se corta por
 * cantidad de intentos. Nunca reintenta motivos permanentes (ambigüedad,
 * datos declarados inválidos, conflicto de stock, etc.): eso requiere
 * corrección humana o del cliente, no tiempo.
 *
 * Deja de reintentar sola cuando el pedido se confirma, se cancela, sale de
 * pendiente_comprobante/en_revision, pasa a un motivo no reintentable o
 * vence su ventana.
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
      args: {
        orderId: number
        declared: TransferVerificationDeclaredInput
        maxAttempts?: number
        minIntervalSeconds?: number
      },
    ) => Promise<TransferVerificationAttemptResult>
  } = {},
) {
  const attempt = deps.attempt ?? attemptTransferAutoVerification
  const now = new Date()
  const startedAt = Date.now()

  // Una consulta por tramo del calendario: cada tramo tiene su propio rango
  // de antigüedad y su propio intervalo mínimo desde el último intento, y
  // ambos se filtran en SQL ANTES del LIMIT (P1 starvation: pedidos que
  // todavía no les toca nunca ocupan lugar en el batch). Todo lo que ya no
  // es candidato real -- motivo permanente, pedido resuelto/cancelado,
  // ventana vencida, sin datos declarados -- también queda afuera acá.
  const tierQueries = TRANSFER_AUTO_RETRY_SCHEDULE.map((tier, index) => {
    const fromHours = index === 0 ? 0 : TRANSFER_AUTO_RETRY_SCHEDULE[index - 1].untilHours
    const newestCreatedAt = new Date(now.getTime() - fromHours * HOUR_MS).toISOString()
    const oldestCreatedAt = new Date(now.getTime() - tier.untilHours * HOUR_MS).toISOString()
    const lastAttemptCutoff = new Date(
      now.getTime() - (tier.intervalMinutes - TRANSFER_AUTO_RETRY_GRACE_MINUTES) * MINUTE_MS,
    ).toISOString()

    return admin
      .from("ordenes")
      .select(RETRY_LOAD_SELECT)
      .eq("payment_method_id", "transferencia")
      .in("payment_status", ["pendiente_comprobante", "en_revision"])
      .or(RETRY_CANDIDATE_FILTER)
      .lt("transfer_verification_attempts", TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS)
      .gt("created_at", oldestCreatedAt)
      .lte("created_at", newestCreatedAt)
      .lte("transfer_last_verification_at", lastAttemptCutoff)
      .not("transfer_amount_declared", "is", null)
      .not("transfer_payer_dni", "is", null)
      .neq("estado", "cancelado")
      .order("transfer_last_verification_at", { ascending: true, nullsFirst: true })
      .limit(MAX_RETRY_CANDIDATES_PER_RUN)
  })

  const results = await Promise.all(tierQueries)
  const loadError = results.find((result) => result.error)?.error
  if (loadError) {
    console.warn("TRANSFER_VERIFICATION_RETRY_LOAD_ERROR", { message: loadError.message })
    return { attempted: 0, verified: 0 }
  }

  const byId = new Map<number, RetryCandidateRow>()
  for (const result of results) {
    for (const row of (result.data ?? []) as RetryCandidateRow[]) byId.set(row.id, row)
  }
  // Los que más tiempo llevan sin revisarse primero, sin importar el tramo.
  const candidates = [...byId.values()]
    .sort(
      (a, b) =>
        new Date(a.transfer_last_verification_at ?? 0).getTime() -
        new Date(b.transfer_last_verification_at ?? 0).getTime(),
    )
    .slice(0, MAX_RETRY_CANDIDATES_PER_RUN)

  let attempted = 0
  let verified = 0

  for (const candidate of candidates) {
    if (Date.now() - startedAt > MAX_RETRY_RUN_DURATION_MS) {
      console.warn("TRANSFER_VERIFICATION_RETRY_TIME_BUDGET_EXCEEDED", {
        attempted,
        remaining: candidates.length - attempted,
      })
      break
    }

    // Defensa en profundidad: la consulta SQL ya filtra todo esto, pero no
    // se depende únicamente de ese filtro.
    const reason = candidate.transfer_verification_failure_reason as
      | TransferManualReviewReason
      | null

    if (!isRetryCandidate(candidate.transfer_verification_status, reason, candidate.transfer_verification_attempts)) continue

    if (
      (candidate.transfer_verification_attempts ?? 0) >=
      TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS
    ) {
      continue
    }

    // El batch pudo tardar en procesarse: revalidar con tiempo fresco evita
    // reclamar una orden que venció mientras esperaba su turno.
    const attemptNow = new Date()
    const createdMs = new Date(candidate.created_at).getTime()
    const intervalMs = getTransferAutoRetryIntervalMs(attemptNow.getTime() - createdMs)
    if (intervalMs === null) continue

    if (
      !isTransferAutoRetryDue({
        createdAt: candidate.created_at,
        lastVerificationAt: candidate.transfer_last_verification_at,
        now: attemptNow,
      })
    ) {
      continue
    }

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
      maxAttempts: TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS,
      // El filtro SQL evita starvation; este límite se verifica otra vez
      // atómicamente en el claim para cerrar carreras entre dos crons.
      minIntervalSeconds: intervalMs / 1000,
    })

    if (result.status === "verified") verified += 1
  }

  return { attempted, verified }
}
