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
  RETRYABLE_MANUAL_REVIEW_REASONS,
  AWAITING_TRANSFER_REASONS,
  isRetryableManualReviewReason,
  isAwaitingTransferReason,
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

/**
 * Cutoff de created_at para que una orden todavía pueda tener una ventana de
 * conciliación vigente (ver getTransferMatchWindow.endDate). Fuente única
 * usada por el cron de reintentos (transfer-verification-retry.ts) para
 * filtrar en la propia consulta SQL, ANTES del LIMIT, las órdenes cuya
 * ventana ya venció -- reintentarlas ahí sólo desperdicia turno del batch,
 * nunca van a poder conciliarse igual.
 */
export function getTransferMatchWindowExpirationCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - TRANSFER_PAYMENT_EXPIRATION_HOURS * 60 * 60 * 1000)
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

/**
 * Calendario del retry AUTOMÁTICO (cron cada ~15 min) durante TODA la
 * ventana de conciliación: frecuente al principio -- cuando es más probable
 * que la transferencia aparezca -- y cada vez más espaciado después, hasta
 * el vencimiento de 48 h. Antes el cron se cortaba por cantidad de intentos
 * (20 x 15 min ≈ 5 h) y el resto de la ventana dependía de que el cliente
 * volviera a verificar. Cada tramo se define por la antigüedad del pedido
 * (desde created_at) y el intervalo mínimo entre dos intentos de ese pedido.
 */
export const TRANSFER_AUTO_RETRY_SCHEDULE: ReadonlyArray<{
  untilHours: number
  intervalMinutes: number
}> = [
  { untilHours: 6, intervalMinutes: 15 },
  { untilHours: 24, intervalMinutes: 60 },
  { untilHours: TRANSFER_PAYMENT_EXPIRATION_HOURS, intervalMinutes: 120 },
]

/**
 * Tolerancia sobre el intervalo: el timer de systemd dispara cada 15 min
 * exactos, pero el intento anterior pudo registrarse unos segundos después
 * del inicio de su corrida. Sin esta tolerancia, un tramo de 15 min se
 * convertiría en 30 min efectivos.
 */
export const TRANSFER_AUTO_RETRY_GRACE_MINUTES = 2

/** Intervalo mínimo (ms) entre dos intentos automáticos, o null si la ventana ya venció. */
export function getTransferAutoRetryIntervalMs(orderAgeMs: number): number | null {
  if (!Number.isFinite(orderAgeMs) || orderAgeMs < 0) return null
  const tier = TRANSFER_AUTO_RETRY_SCHEDULE.find(({ untilHours }) => orderAgeMs < untilHours * HOUR_MS)
  if (!tier) return null
  return (tier.intervalMinutes - TRANSFER_AUTO_RETRY_GRACE_MINUTES) * MINUTE_MS
}

/**
 * ¿Le toca un intento automático a este pedido ahora? Sólo depende de la
 * antigüedad del pedido y del ÚLTIMO intento (automático o manual: si el
 * cliente acaba de verificar, el cron no repite la misma búsqueda).
 */
export function isTransferAutoRetryDue({
  createdAt,
  lastVerificationAt,
  now = new Date(),
}: {
  createdAt: string | Date
  lastVerificationAt: string | Date | null | undefined
  now?: Date
}): boolean {
  const createdMs = new Date(createdAt).getTime()
  const intervalMs = getTransferAutoRetryIntervalMs(now.getTime() - createdMs)
  if (intervalMs === null) return false
  if (!lastVerificationAt) return true
  const lastMs = new Date(lastVerificationAt).getTime()
  return !Number.isFinite(lastMs) || now.getTime() - lastMs >= intervalMs
}

/**
 * Cota superior de intentos automáticos que un pedido puede recibir en toda
 * su ventana: dentro de cada tramo, dos intentos automáticos siempre quedan
 * separados por al menos (intervalo - tolerancia), tanto en el filtro del
 * cron como en p_min_interval_seconds de la RPC. Así, en un tramo de
 * duración L caben como máximo floor(L / separación) + 1. No depende de la
 * frecuencia real del timer ni de que dos crons hayan cargado el mismo batch.
 * Una verificación manual intercalada actualiza el mismo timestamp y sólo
 * posterga el siguiente claim automático.
 */
export const TRANSFER_VERIFICATION_MAX_AUTOMATIC_ATTEMPTS = TRANSFER_AUTO_RETRY_SCHEDULE.reduce(
  (total, tier, index) => {
    const fromHours = index === 0 ? 0 : TRANSFER_AUTO_RETRY_SCHEDULE[index - 1].untilHours
    const spacingMinutes = tier.intervalMinutes - TRANSFER_AUTO_RETRY_GRACE_MINUTES
    return total + Math.floor(((tier.untilHours - fromHours) * 60) / spacingMinutes) + 1
  },
  0,
)

/** Intentos manuales garantizados al cliente, sin importar cuántos haya hecho el cron. */
export const TRANSFER_VERIFICATION_MANUAL_ATTEMPTS = 30

/**
 * El contador transfer_verification_attempts es uno solo (manual +
 * automático) y claim_transfer_verification_attempt lo compara contra el
 * p_max_attempts que recibe. Separar el contador requeriría una migración;
 * en cambio, los topes se derivan de la cota automática:
 *
 * - cliente: MAX_AUTOMATIC + MANUAL -> como el cron nunca supera
 *   MAX_AUTOMATIC, el cliente siempre conserva al menos MANUAL intentos;
 * - cron: tope del cliente + MAX_AUTOMATIC -> los intentos manuales nunca
 *   alcanzan para bloquear un intento automático que corresponde.
 *
 * La protección antiabuso real del cliente es el intervalo mínimo entre
 * intentos (TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS) más este tope.
 */
export const TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS =
  TRANSFER_VERIFICATION_MAX_AUTOMATIC_ATTEMPTS + TRANSFER_VERIFICATION_MANUAL_ATTEMPTS

export const TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS =
  TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS + TRANSFER_VERIFICATION_MAX_AUTOMATIC_ATTEMPTS

/**
 * Espera mínima entre dos intentos del mismo pedido (p_min_interval_seconds
 * de claim_transfer_verification_attempt). Se informa al cliente para
 * mostrar la cuenta regresiva antes de volver a verificar.
 */
export const TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS = 10

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

  // La unicidad se exige sobre las transferencias que cumplen AMBAS reglas
  // obligatorias (monto exacto + documento derivado === declarado), no sólo
  // el monto: antes, cualquier otra transferencia del mismo importe dentro
  // de la ventana de 48 h (de otro pagador, o ya usada por otro pedido)
  // dejaba el pedido en multiple_candidates para siempre, aunque la
  // transferencia real del cliente apareciera después. Una transferencia
  // de otro documento nunca puede ser la del titular declarado.
  const evaluated = amountMatches.map((candidate) => ({
    candidate,
    dniDerivation: deriveArgentineDni({
      type: candidate.identificationType,
      number: candidate.identificationNumber,
    }),
  }))
  const fullMatches = evaluated.filter(
    ({ dniDerivation }) => dniDerivation.dni === normalizedDeclaredDni,
  )

  if (fullMatches.length > 1) {
    return { kind: "manual_review", reason: "multiple_candidates" }
  }

  if (fullMatches.length === 1) {
    return { kind: "verified", ...fullMatches[0] }
  }

  // Sin coincidencia: si alguna transferencia del monto exacto no trae un
  // documento utilizable, podría ser la del cliente -- requiere un humano.
  if (evaluated.some(({ dniDerivation }) => !dniDerivation.dni)) {
    return { kind: "manual_review", reason: "identification_unavailable" }
  }

  return { kind: "manual_review", reason: "dni_mismatch" }
}
