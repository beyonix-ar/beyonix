import "server-only"

import {
  deriveArgentineDni,
  normalizeDeclaredDni,
  type ArgentineDniDerivationResult,
} from "../payments/argentine-identification.ts"
import { moneyToCents } from "../mercadopago/order-payment.ts"
import type { MercadoPagoBankTransferCandidate } from "../mercadopago/bank-transfer-search.ts"
import { TRANSFER_PAYMENT_EXPIRATION_HOURS } from "./transfer-expiration.ts"

export {
  TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
  isRetryableManualReviewReason,
  getManualReviewCustomerMessage,
  describeManualReviewReason,
  type TransferManualReviewReason,
} from "./transfer-verification-reasons.ts"
import type { TransferManualReviewReason } from "./transfer-verification-reasons.ts"

/**
 * Tolerancia hacia atrás sobre order.created_at: nunca reemplaza la política
 * real de vencimiento de BEYONIX (TRANSFER_PAYMENT_EXPIRATION_HOURS, 48 h,
 * reutilizada tal cual para el límite superior de la ventana) -- sólo
 * absorbe pequeñas diferencias de reloj/latencia entre la creación del
 * pedido y el momento real de la transferencia.
 */
export const TRANSFER_MATCH_LOOKBACK_MINUTES = 15

export function getTransferMatchWindow(orderCreatedAt: string | Date): {
  beginDate: Date
  endDate: Date
} {
  const createdAt =
    orderCreatedAt instanceof Date ? orderCreatedAt : new Date(orderCreatedAt)

  return {
    beginDate: new Date(
      createdAt.getTime() - TRANSFER_MATCH_LOOKBACK_MINUTES * 60 * 1000,
    ),
    endDate: new Date(
      createdAt.getTime() + TRANSFER_PAYMENT_EXPIRATION_HOURS * 60 * 60 * 1000,
    ),
  }
}

export type TransferAutoVerificationOutcome =
  | {
      kind: "verified"
      candidate: MercadoPagoBankTransferCandidate
      dniDerivation: ArgentineDniDerivationResult
    }
  | { kind: "manual_review"; reason: TransferManualReviewReason }

/**
 * Algoritmo puro de conciliación. Implementa la regla principal de
 * auto-validación: exige monto exacto (informado por el cliente Y real de
 * Mercado Pago), documento derivado===declarado, y un único candidato en la
 * ventana. Ante cualquier ambigüedad devuelve manual_review -- nunca
 * auto-confirma "por las dudas".
 *
 * `candidates` ya debe venir filtrado por ventana temporal, status=approved
 * y operation_type/payment_method_id soportados (ver
 * lib/mercadopago/bank-transfer-search.ts) -- esta función no vuelve a
 * validar esos tres puntos.
 */
export function matchBankTransferPayment({
  expectedAmount,
  declaredAmount,
  declaredDni,
  candidates,
  excludePaymentIds,
}: {
  expectedAmount: number
  declaredAmount: number
  declaredDni: string | null | undefined
  candidates: MercadoPagoBankTransferCandidate[]
  excludePaymentIds?: ReadonlySet<string>
}): TransferAutoVerificationOutcome {
  const expectedCents = moneyToCents(expectedAmount)
  const declaredCents = moneyToCents(declaredAmount)

  if (
    expectedCents === null ||
    expectedCents <= 0 ||
    declaredCents === null ||
    declaredCents !== expectedCents
  ) {
    return { kind: "manual_review", reason: "declared_amount_mismatch" }
  }

  const normalizedDeclaredDni = normalizeDeclaredDni(declaredDni)
  if (!normalizedDeclaredDni) {
    return { kind: "manual_review", reason: "declared_dni_invalid" }
  }

  const eligibleCandidates = excludePaymentIds
    ? candidates.filter((candidate) => !excludePaymentIds.has(candidate.id))
    : candidates

  const amountMatches = eligibleCandidates.filter(
    (candidate) => moneyToCents(candidate.transactionAmount) === expectedCents,
  )

  if (amountMatches.length === 0) {
    return {
      kind: "manual_review",
      reason: eligibleCandidates.length > 0 ? "amount_mismatch_mp" : "no_candidates",
    }
  }

  if (amountMatches.length > 1) {
    return { kind: "manual_review", reason: "multiple_candidates" }
  }

  const candidate = amountMatches[0]
  const dniDerivation = deriveArgentineDni({
    type: candidate.identificationType,
    number: candidate.identificationNumber,
  })

  if (!dniDerivation.dni) {
    return { kind: "manual_review", reason: "identification_unavailable" }
  }

  if (dniDerivation.dni !== normalizedDeclaredDni) {
    return { kind: "manual_review", reason: "dni_mismatch" }
  }

  return { kind: "verified", candidate, dniDerivation }
}
