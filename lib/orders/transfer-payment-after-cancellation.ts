import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import { sendOrderStatusEmail } from "../email/send-order-status-email.ts"
import { searchIncomingBankTransfers } from "../mercadopago/bank-transfer-search.ts"
import type { BankTransferSearchResult } from "../mercadopago/bank-transfer-search.ts"
import {
  MERCADOPAGO_APPROVED_AFTER_CANCELLATION_STATUS,
  moneyToCents,
} from "../mercadopago/order-payment.ts"
import {
  getTransferMatchWindow,
  isTransferAutoRetryDue,
  matchBankTransferPayment,
  TRANSFER_AUTO_RETRY_GRACE_MINUTES,
  TRANSFER_AUTO_RETRY_SCHEDULE,
} from "./transfer-auto-verification.ts"
import { TRANSFER_SUPERSEDED_PAYMENT_STATUS } from "./transfer-checkout-attempt.ts"
import {
  TRANSFER_PAYMENT_EXPIRATION_HOURS,
  TRANSFER_PAYMENT_EXPIRED_STATUS,
} from "./transfer-expiration.ts"
import { loadPaymentIdsClaimedByOtherOrders } from "./transfer-verification-service.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Cancelaciones automáticas SIN pago de un pedido por transferencia: nuevo
 * intento con la reserva vencida (checkout_superseded) o fin de la ventana
 * técnica (vencido_falta_comprobante). En ambas el saldo a favor y el
 * beneficio ya se devolvieron.
 */
export const TRANSFER_CANCELLED_WITHOUT_PAYMENT_STATUSES = [
  TRANSFER_SUPERSEDED_PAYMENT_STATUS,
  TRANSFER_PAYMENT_EXPIRED_STATUS,
] as const

/** Estado existente (también lo usa el webhook de Mercado Pago): pago real sobre un pedido cancelado. */
export const TRANSFER_PAYMENT_AFTER_CANCELLATION_STATUS = MERCADOPAGO_APPROVED_AFTER_CANCELLATION_STATUS

export const TRANSFER_PAYMENT_AFTER_CANCELLATION_CUSTOMER_MESSAGE =
  "Recibimos tu transferencia, pero el pedido ya se había cancelado porque venció la reserva. No la aplicamos a ninguna compra: nuestro equipo se va a comunicar para resolverlo."

const MAX_CANDIDATES_PER_RUN = 25
const MAX_RUN_DURATION_MS = 45_000
const HOUR_MS = 60 * 60 * 1000
const MIN_SPACING_MS =
  (TRANSFER_AUTO_RETRY_SCHEDULE[0].intervalMinutes - TRANSFER_AUTO_RETRY_GRACE_MINUTES) * 60 * 1000

const CANDIDATE_SELECT =
  "id, created_at, cliente_email, cliente_nombre, transfer_payer_dni, transfer_amount_declared, transfer_last_verification_at"

interface CancelledTransferCandidate {
  id: number
  created_at: string
  cliente_email: string | null
  cliente_nombre: string | null
  transfer_payer_dni: string | null
  transfer_amount_declared: number | string | null
  transfer_last_verification_at: string | null
}

export interface TransferPaymentAfterCancellationDeps {
  searchTransfers?: (window: { beginDate: Date; endDate: Date }) => Promise<BankTransferSearchResult>
  now?: () => Date
  notify?: typeof sendOrderStatusEmail
}

/**
 * Busca, dentro de la ventana técnica de 48 h, transferencias reales de
 * pedidos cancelados sin pago y las REGISTRA sin confirmar nada
 * (record_transfer_payment_after_cancellation): el payment.id queda reclamado
 * para ese pedido, el pedido pasa a approved_after_cancellation (acción
 * urgente en Admin) y el cliente recibe un aviso. Nunca reacredita saldo,
 * reactiva beneficios ni toca stock. Mismo matching estricto que la
 * verificación normal (monto exacto, DNI derivado, candidato único, payment.id
 * libre); el monto es el que se le indicó transferir.
 */
export async function detectTransferPaymentsAfterCancellation(
  admin: AdminClient,
  deps: TransferPaymentAfterCancellationDeps = {},
) {
  const searchTransfers = deps.searchTransfers ?? searchIncomingBankTransfers
  const now = deps.now ?? (() => new Date())
  const notify = deps.notify ?? sendOrderStatusEmail
  const startedAt = Date.now()
  const runNow = now()

  const { data, error } = await admin
    .from("ordenes")
    .select(CANDIDATE_SELECT)
    .eq("payment_method_id", "transferencia")
    .eq("estado", "cancelado")
    .in("payment_status", [...TRANSFER_CANCELLED_WITHOUT_PAYMENT_STATUSES])
    .is("transfer_matched_payment_id", null)
    .not("transfer_payer_dni", "is", null)
    .not("transfer_amount_declared", "is", null)
    .gt("created_at", new Date(runNow.getTime() - TRANSFER_PAYMENT_EXPIRATION_HOURS * HOUR_MS).toISOString())
    .or(`transfer_last_verification_at.is.null,transfer_last_verification_at.lte.${new Date(runNow.getTime() - MIN_SPACING_MS).toISOString()}`)
    .order("transfer_last_verification_at", { ascending: true, nullsFirst: true })
    .limit(MAX_CANDIDATES_PER_RUN)

  if (error) {
    console.warn("TRANSFER_AFTER_CANCELLATION_LOAD_ERROR", { message: error.message })
    return { searched: 0, detected: 0 }
  }

  let searched = 0
  let detected = 0

  for (const candidate of (data ?? []) as CancelledTransferCandidate[]) {
    if (Date.now() - startedAt > MAX_RUN_DURATION_MS) break
    const attemptNow = now()
    if (!isTransferAutoRetryDue({
      createdAt: candidate.created_at,
      lastVerificationAt: candidate.transfer_last_verification_at,
      now: attemptNow,
    })) continue

    const declaredAmount = Number(candidate.transfer_amount_declared)
    if (!candidate.transfer_payer_dni || moneyToCents(declaredAmount) === null) continue

    // Reclama el turno de búsqueda de forma atómica: dos corridas nunca
    // consultan el mismo pedido a la vez (el UPDATE re-evalúa la condición
    // bajo el lock de la fila).
    let claim = admin
      .from("ordenes")
      .update({ transfer_last_verification_at: attemptNow.toISOString() } as never)
      .eq("id", candidate.id)
      .eq("estado", "cancelado")
      .in("payment_status", [...TRANSFER_CANCELLED_WITHOUT_PAYMENT_STATUSES])
      .is("transfer_matched_payment_id", null)
    claim = candidate.transfer_last_verification_at
      ? claim.eq("transfer_last_verification_at", candidate.transfer_last_verification_at)
      : claim.is("transfer_last_verification_at", null)
    const { data: claimed, error: claimError } = await claim.select("id").maybeSingle()
    if (claimError || !claimed) continue
    searched += 1

    let searchResult: BankTransferSearchResult
    try {
      searchResult = await searchTransfers(getTransferMatchWindow(candidate.created_at))
    } catch (searchError) {
      console.error("TRANSFER_AFTER_CANCELLATION_SEARCH_ERROR", {
        orderId: candidate.id,
        message: searchError instanceof Error ? searchError.message : String(searchError),
      })
      continue
    }
    if (!searchResult.exhaustive) continue

    let claimedByOthers: Set<string>
    try {
      const declaredCents = moneyToCents(declaredAmount)
      claimedByOthers = await loadPaymentIdsClaimedByOtherOrders(
        admin,
        candidate.id,
        searchResult.candidates
          .filter((payment) => moneyToCents(payment.transactionAmount) === declaredCents)
          .map((payment) => payment.id),
      )
    } catch {
      continue
    }

    const match = matchBankTransferPayment({
      expectedAmount: declaredAmount,
      declaredAmount,
      declaredDni: candidate.transfer_payer_dni,
      candidates: searchResult.candidates,
      excludePaymentIds: claimedByOthers,
    })
    if (match.kind !== "verified") continue

    const { candidate: payment, dniDerivation } = match
    const { error: recordError } = await admin.rpc("record_transfer_payment_after_cancellation", {
      p_order_id: candidate.id,
      p_matched_payment_id: payment.id,
      p_matched_operation_type: payment.operationType,
      p_matched_payment_method_id: payment.paymentMethodId,
      p_matched_amount: payment.transactionAmount,
      p_matched_identification_type: payment.identificationType,
      p_matched_identification_number: payment.identificationNumber,
      p_matched_dni_derived: dniDerivation.dni,
      p_matched_bank_transfer_id: payment.bankTransferId,
      p_matched_date_created: payment.dateCreated,
      p_matched_date_approved: payment.dateApproved,
    })
    if (recordError) {
      console.error("TRANSFER_AFTER_CANCELLATION_RECORD_ERROR", {
        orderId: candidate.id,
        message: recordError.message,
      })
      continue
    }

    detected += 1
    console.error("TRANSFER_PAYMENT_AFTER_CANCELLATION", { orderId: candidate.id, paymentId: payment.id })
    await notify({
      to: candidate.cliente_email,
      subject: `Recibimos tu transferencia BX-${1000 + candidate.id}`,
      html: `
        <h1>Recibimos tu transferencia</h1>
        <p>Hola ${candidate.cliente_nombre ?? ""}, ${TRANSFER_PAYMENT_AFTER_CANCELLATION_CUSTOMER_MESSAGE}</p>
      `,
    })
  }

  return { searched, detected }
}
