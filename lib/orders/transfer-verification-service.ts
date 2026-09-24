import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import type { SupabasePedido } from "../supabase/types.ts"
import { expireTransferOrderIfNeeded } from "./transfer-expiration.ts"
import { searchIncomingBankTransfers } from "../mercadopago/bank-transfer-search.ts"
import type { BankTransferSearchResult } from "../mercadopago/bank-transfer-search.ts"
import {
  TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS,
  getTransferMatchWindow,
  matchBankTransferPayment,
  type TransferManualReviewReason,
} from "./transfer-auto-verification.ts"
import {
  normalizeDeclaredDni,
  parseDeclaredPayerDocument,
} from "../payments/argentine-identification.ts"
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

/**
 * P0 (tercera auditoría): TODO write perteneciente a un intento de
 * verificación tiene que quedar fenceado por lease, no sólo confirm/release.
 * Antes este UPDATE filtraba únicamente por orderId -- un intento viejo (A)
 * que perdió su lease porque un intento nuevo (B) ya reclamó el mismo pedido
 * podía seguir corriendo (por ejemplo, todavía terminando de resolver
 * normalizeDeclaredDni o esperando el turno del event loop) y sobreescribir
 * acá los datos declarados que B ya había guardado, aunque A ya no fuera el
 * intento vigente. Ahora exige también transfer_verification_lease_id =
 * leaseId: si el lease ya no es el vigente, este UPDATE no afecta ninguna
 * fila (no-op), nunca pisa lo que escribió el intento vigente.
 *
 * Sin lease (nunca debería pasar tras un claim exitoso, pero se trata
 * explícitamente en vez de dejar un camino especial): no se ejecuta ningún
 * write -- un intento sin lease nunca puede escribir sobre una verificación
 * reclamada.
 */
export async function persistDeclaredInput(
  admin: AdminClient,
  orderId: number,
  declared: TransferVerificationDeclaredInput,
  declaredDocument: string | null,
  leaseId: string | null,
) {
  if (!leaseId) {
    console.warn("TRANSFER_VERIFICATION_PERSIST_DECLARED_INPUT_NO_LEASE", { orderId })
    return
  }

  await admin
    .from("ordenes")
    .update({
      transfer_payer_first_name: declared.firstName.trim().slice(0, 200) || null,
      transfer_payer_last_name: declared.lastName.trim().slice(0, 200) || null,
      transfer_payer_dni: declaredDocument ?? (declared.dni.trim().slice(0, 20) || null),
      transfer_amount_declared: Number.isFinite(declared.amount) ? declared.amount : null,
    })
    .eq("id", orderId)
    .eq("transfer_verification_lease_id", leaseId)
}

/**
 * P0 (cuarta auditoría): regla absoluta -- si no hay un lease válido, el
 * intento NO PUEDE ESCRIBIR NADA. Antes, sin leaseId el filtro de lease se
 * omitía por completo (`if (leaseId) query = query.eq(...)`) y el UPDATE
 * quedaba filtrando sólo por id + status='checking': un intento SIN lease
 * (que nunca debería poder escribir nada) igual podía mover a
 * manual_review/pending un pedido cuyo "checking" pertenecía a otro intento
 * (B) vigente, pisando su estado. Ahora, sin lease, se aborta ANTES de
 * construir el UPDATE -- nunca hay un camino que filtre "sólo por orderId".
 * Con lease, el filtro por transfer_verification_lease_id es incondicional.
 */
export async function releaseVerificationLock(
  admin: AdminClient,
  orderId: number,
  fallbackStatus: "pending" | "manual_review",
  reason: TransferManualReviewReason | null,
  leaseId: string | null,
) {
  if (!leaseId) {
    console.warn("TRANSFER_VERIFICATION_RELEASE_LOCK_NO_LEASE", { orderId })
    return
  }

  await admin
    .from("ordenes")
    .update({
      transfer_verification_status: fallbackStatus,
      transfer_verification_failure_reason: reason,
    })
    .eq("id", orderId)
    .eq("transfer_verification_status", "checking")
    .eq("transfer_verification_lease_id", leaseId)
}

async function finalizeManualReview(
  admin: AdminClient,
  orderId: number,
  reason: TransferManualReviewReason,
  fallbackOrder: SupabasePedido,
  leaseId: string | null,
): Promise<TransferVerificationAttemptResult> {
  await releaseVerificationLock(admin, orderId, "manual_review", reason, leaseId)
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
  }) => Promise<BankTransferSearchResult>
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

  // P0 (segunda auditoría): fencing token del intento vigente -- todo
  // release/confirm posterior de ESTE intento tiene que quedar scopeado a
  // este lease, para que un intento viejo (reemplazado por uno nuevo) nunca
  // pueda pisar el estado del intento vigente al terminar tarde.
  const leaseId = (claimedOrder.transfer_verification_lease_id as string | null) ?? null

  // Se guarda el documento tal como lo declaró el cliente (DNI o CUIT/CUIL
  // normalizado), no el DNI derivado: el admin concilia contra lo informado.
  const declaredDocument = parseDeclaredPayerDocument(declared.dni)?.number ?? null
  await persistDeclaredInput(admin, orderId, declared, declaredDocument, leaseId)

  const order = await expireTransferOrderIfNeeded(admin, claimedOrder)

  if (
    order.estado === "cancelado" ||
    !ELIGIBLE_PAYMENT_STATUSES.has(order.payment_status ?? "")
  ) {
    await releaseVerificationLock(admin, orderId, "pending", null, leaseId)
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
    return finalizeManualReview(admin, orderId, "declared_amount_mismatch", order, leaseId)
  }
  if (!normalizedDeclaredDniForFastPath) {
    return finalizeManualReview(admin, orderId, "declared_dni_invalid", order, leaseId)
  }

  let searchResult: BankTransferSearchResult
  try {
    const { beginDate, endDate } = getTransferMatchWindow(order.created_at)
    searchResult = await searchTransfers({ beginDate, endDate })
  } catch (error) {
    console.error("TRANSFER_AUTO_VERIFICATION_MP_SEARCH_ERROR", {
      orderId,
      message: error instanceof Error ? error.message : String(error),
    })
    return finalizeManualReview(admin, orderId, "mercadopago_unavailable", order, leaseId)
  }

  // P0: una auto-confirmación sólo puede ocurrir si se puede demostrar que
  // el conjunto relevante de candidatos fue evaluado completamente (ver
  // BankTransferSearchResult.exhaustive en bank-transfer-search.ts). Si la
  // búsqueda se cortó por el tope defensivo de páginas sin poder probarlo,
  // nunca se auto-confirma con lo que se llegó a traer -- ante la duda,
  // revisión manual.
  if (!searchResult.exhaustive) {
    console.warn("TRANSFER_AUTO_VERIFICATION_SEARCH_NOT_EXHAUSTIVE", {
      orderId,
      candidatesFound: searchResult.candidates.length,
    })
    return finalizeManualReview(admin, orderId, "search_not_exhaustive", order, leaseId)
  }

  const matchResult = matchBankTransferPayment({
    expectedAmount,
    declaredAmount: declared.amount,
    declaredDni: declared.dni,
    candidates: searchResult.candidates,
  })

  if (matchResult.kind === "manual_review") {
    return finalizeManualReview(admin, orderId, matchResult.reason, order, leaseId)
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
      p_lease_id: leaseId,
    },
  )

  if (confirmError || !confirmedData) {
    const code = extractErrorCode(confirmError?.message)

    if (code === "TRANSFER_PAYMENT_ID_ALREADY_USED") {
      return finalizeManualReview(admin, orderId, "payment_id_already_used", order, leaseId)
    }

    if (code === "AMOUNT_MISMATCH") {
      return finalizeManualReview(admin, orderId, "expected_amount_changed", order, leaseId)
    }

    // P0 (tercera auditoría): este intento ya no es (o nunca fue) el
    // vigente -- otro intento reclamó el pedido y avanzó (o ya confirmó)
    // mientras éste seguía corriendo, o el lease vigente venció, o el pedido
    // ya no está en estado "checking". NUNCA se toca el estado de la orden
    // en ninguno de estos casos: hacerlo podría pisar lo que el intento
    // vigente ya haya escrito.
    if (
      code === "LEASE_EXPIRED" ||
      code === "LEASE_MISSING" ||
      code === "LEASE_MISMATCH" ||
      code === "INVALID_VERIFICATION_STATE"
    ) {
      return {
        status: "rejected",
        message: "Tu verificación fue reemplazada por un intento más reciente.",
      }
    }

    console.error("TRANSFER_AUTO_VERIFICATION_CONFIRM_ERROR", {
      orderId,
      message: confirmError?.message,
    })
    await releaseVerificationLock(admin, orderId, "pending", null, leaseId)
    return {
      status: "rejected",
      message: "No se pudo confirmar la transferencia. Intentá nuevamente.",
    }
  }

  const confirmedOrder = firstRow<SupabasePedido>(confirmedData)!

  // La RPC (migración 20260914090000) reclama transfer_matched_payment_id de
  // forma atómica -- bajo el mismo lock -- incluso cuando el guardián de
  // inventario rechaza la confirmación por falta de stock. En ese caso NO
  // lanza una excepción: devuelve la orden ya actualizada con este
  // payment_status. Ya no es un error a interpretar acá, sólo un resultado
  // distinto a "verified".
  if (confirmedOrder.payment_status === TRANSFER_STOCK_CONFLICT_PAYMENT_STATUS) {
    return {
      status: "manual_review",
      reason: "stock_conflict",
      order: confirmedOrder,
    }
  }

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
