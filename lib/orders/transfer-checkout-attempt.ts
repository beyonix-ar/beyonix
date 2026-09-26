import "server-only"

import { createHash } from "node:crypto"

import { reverseCustomerCreditForOrder } from "../customer-credit/server.ts"
import { restoreStoreBenefitFromSupersededOrder } from "../customer-store-benefits.ts"
import { stableStringify } from "../pricing/checkout-pricing.ts"
import type { TransferEconomicState } from "../payments/transfer-checkout.ts"
import type { createAdminClient } from "../supabase/admin.ts"
import { appendOrderAuditEvent } from "./order-audit.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export const TRANSFER_ECONOMIC_FINGERPRINT_PREFIX = "transfer-economics:v1:"
export const TRANSFER_SUPERSEDED_PAYMENT_STATUS = "checkout_superseded"

/** Estados de un pedido por transferencia que todavía no tiene NINGÚN rastro de pago. */
const SUPERSEDABLE_TRANSFER_PAYMENT_STATUSES = ["pendiente_comprobante", "pending"] as const

export function createTransferEconomicFingerprint(state: TransferEconomicState) {
  return `${TRANSFER_ECONOMIC_FINGERPRINT_PREFIX}${createHash("sha256")
    .update(stableStringify(state))
    .digest("hex")}`
}

export interface PendingCheckoutOrderRow {
  id: number
  estado: string
  usuario_id?: string | null
  payment_method_id?: string | null
  payment_status?: string | null
  financial_status?: string | null
  payment_proof_url?: string | null
  payment_proof_uploaded_at?: string | null
  transfer_verification_status?: string | null
  transfer_verification_attempts?: number | null
  transfer_amount_declared?: number | null
  transfer_payer_dni?: string | null
  transfer_matched_payment_id?: string | null
  total?: number | null
  external_amount_due?: number | null
  credit_balance_used?: number | null
  store_benefit_id?: string | null
  checkout_idempotency_key?: string | null
  pricing_snapshot?: { economicFingerprint?: string | null } | null
}

export type PendingTransferCheckoutAction =
  | "mercadopago_attempt"
  | "other_payment_method"
  | "resume_equivalent"
  | "supersede_stale"

/**
 * Orden pendiente de la MISMA compra (índice `customer_checkout_fingerprint`,
 * que no incluye precios) cuando el cliente confirma una transferencia:
 * - intento de Mercado Pago -> nunca equivale a una transferencia: se da de
 *   baja con el flujo seguro de MP (si no hay pago en curso);
 * - transferencia con la misma huella económica -> es la misma compra
 *   (doble click, dos pestañas, reintento): se devuelve, nunca se duplica;
 * - transferencia con otra huella (o sin huella: pedido previo a esta
 *   versión) -> obsoleta: se da de baja si no tiene ningún rastro de pago.
 */
export function getPendingTransferCheckoutAction(
  order: Pick<PendingCheckoutOrderRow, "payment_method_id" | "pricing_snapshot">,
  currentEconomicFingerprint: string,
): PendingTransferCheckoutAction {
  if (order.payment_method_id === "mercadopago") return "mercadopago_attempt"
  if (order.payment_method_id !== "transferencia") return "other_payment_method"

  const fingerprint = order.pricing_snapshot?.economicFingerprint
  return typeof fingerprint === "string" &&
    fingerprint.startsWith(TRANSFER_ECONOMIC_FINGERPRINT_PREFIX) &&
    fingerprint === currentEconomicFingerprint
    ? "resume_equivalent"
    : "supersede_stale"
}

/**
 * Evidencia REAL de pago: el dinero pudo haber llegado o un humano tiene que
 * mirarlo (comprobante, payment.id conciliado, pago confirmado / en revisión /
 * en conflicto, conciliación en curso o en revisión manual). Los datos del
 * titular (se piden antes de mostrar alias/CVU) y los reintentos que todavía
 * no encontraron ninguna transferencia NO son evidencia.
 */
export function hasTransferPaymentEvidence(order: PendingCheckoutOrderRow) {
  return (
    order.estado !== "pendiente" ||
    !SUPERSEDABLE_TRANSFER_PAYMENT_STATUSES.includes(
      (order.payment_status ?? "") as (typeof SUPERSEDABLE_TRANSFER_PAYMENT_STATUSES)[number],
    ) ||
    ![null, undefined, "pending_payment"].includes(order.financial_status) ||
    Boolean(order.payment_proof_url || order.payment_proof_uploaded_at) ||
    Boolean(order.transfer_matched_payment_id) ||
    ![null, undefined, "pending"].includes(order.transfer_verification_status)
  )
}

/**
 * ¿Se puede dar de baja automáticamente dentro del plazo? Sólo si no hay
 * evidencia de pago y el cliente tampoco inició una verificación (pudo haber
 * transferido y estar esperando que aparezca). transfer_verification_status
 * nace en 'pending' (default de la columna): "sin verificación iniciada" es
 * null o 'pending' con cero intentos.
 */
export function isTransferOrderSupersedable(order: PendingCheckoutOrderRow) {
  return (
    order.payment_method_id === "transferencia" &&
    !hasTransferPaymentEvidence(order) &&
    (order.transfer_verification_attempts ?? 0) === 0
  )
}

function holdsCustomerCreditOrBenefit(order: PendingCheckoutOrderRow) {
  return Number(order.credit_balance_used ?? 0) > 0 || Boolean(order.store_benefit_id)
}

export type SupersedeTransferOrderResult = "superseded" | "payment_in_review" | "busy"

export type SupersedeTransferOrderReason = "economic_conditions_changed" | "reservation_expired"

/**
 * Cancela (nunca borra) un intento sin evidencia de pago con un UPDATE
 * condicional que la re-verifica bajo el lock de fila; el trigger
 * `release_order_stock_reservation` libera su reserva. Sólo quien gana ese
 * UPDATE devuelve saldo (reverse_customer_credit_for_order, idempotente) y
 * beneficio (sólo si sigue ligado a ESTE pedido): nunca se duplica.
 */
async function cancelTransferAttemptWithoutPayment(
  admin: AdminClient,
  order: PendingCheckoutOrderRow,
  {
    reason,
    currentEconomicFingerprint,
    requireNoVerificationAttempts,
    now,
  }: {
    reason: SupersedeTransferOrderReason
    currentEconomicFingerprint: string
    requireNoVerificationAttempts: boolean
    now: Date
  },
): Promise<"superseded" | "busy"> {
  let update = admin
    .from("ordenes")
    .update({
      estado: "cancelado",
      payment_status: TRANSFER_SUPERSEDED_PAYMENT_STATUS,
      financial_status: "cancelled",
      cancelled_at: now.toISOString(),
    } as never)
    .eq("id", order.id)
    .eq("payment_method_id", "transferencia")
    .eq("estado", "pendiente")
    .in("payment_status", [...SUPERSEDABLE_TRANSFER_PAYMENT_STATUSES])
    .is("payment_proof_url", null)
    .is("payment_proof_uploaded_at", null)
    .is("transfer_matched_payment_id", null)
    .or("transfer_verification_status.is.null,transfer_verification_status.eq.pending")
  if (requireNoVerificationAttempts) update = update.eq("transfer_verification_attempts", 0)

  const { data: updated, error } = await update.select("id").maybeSingle()

  if (error) {
    throw new Error(error.message || "No se pudo actualizar el pedido anterior.")
  }

  // Otro request lo tocó entre la lectura y este UPDATE (comprobante,
  // verificación, cron, otra pestaña): nunca se asume nada.
  if (!updated) return "busy"

  if (Number(order.credit_balance_used ?? 0) > 0) {
    await reverseCustomerCreditForOrder(admin, {
      orderId: order.id,
      description:
        reason === "reservation_expired"
          ? "Reintegro de saldo: la reserva de la compra venció sin pago"
          : "Reintegro de saldo: la compra se actualizó con nuevos precios o condiciones",
    })
  }

  if (order.store_benefit_id) {
    await restoreStoreBenefitFromSupersededOrder(admin, {
      benefitId: order.store_benefit_id,
      orderId: order.id,
    })
  }

  await appendOrderAuditEvent(admin, {
    orderId: order.id,
    actorType: "system",
    action: "transfer_checkout_superseded",
    previousStatus: order.financial_status ?? "pending_payment",
    newStatus: "cancelled",
    metadata: {
      reason,
      previousTotal: order.total ?? null,
      previousExternalAmountDue: order.external_amount_due ?? null,
      previousEconomicFingerprint: order.pricing_snapshot?.economicFingerprint ?? null,
      currentEconomicFingerprint,
    },
  })

  return "superseded"
}

/**
 * Da de baja un pedido por transferencia económicamente obsoleto de la misma
 * compra (dentro del plazo), para que el cliente continúe con el total actual.
 */
export async function supersedeStaleTransferOrder(
  admin: AdminClient,
  order: PendingCheckoutOrderRow,
  {
    currentEconomicFingerprint,
    reason = "economic_conditions_changed",
    now = new Date(),
  }: {
    currentEconomicFingerprint: string
    reason?: SupersedeTransferOrderReason
    now?: Date
  },
): Promise<SupersedeTransferOrderResult> {
  if (!isTransferOrderSupersedable(order)) return "payment_in_review"
  return cancelTransferAttemptWithoutPayment(admin, order, {
    reason,
    currentEconomicFingerprint,
    requireNoVerificationAttempts: true,
    now,
  })
}

export type RetireExpiredTransferAttemptResult = "superseded" | "detached" | "busy"

/**
 * El cliente inicia una compra NUEVA (nueva reserva del Paso 3) mientras el
 * pedido anterior de la misma compra sigue pendiente con su reserva de 20
 * minutos vencida. Nunca se reanuda ese pedido (reviviría la reserva vieja):
 *
 * 1. Evidencia real de pago -> se conserva con su saldo/beneficio hasta que se
 *    resuelva (confirmación, conflicto o rechazo); sólo se desliga del índice
 *    de "compra en curso" para que el intento nuevo no choque contra él.
 * 2. Sin evidencia y reteniendo saldo a favor o beneficio -> se da de baja y
 *    se devuelven: no puede quedar saldo/beneficio bloqueado en un pedido que
 *    nunca recibió un pago.
 * 3. Sin evidencia, sin nada retenido y con los datos del titular ya
 *    informados (vio alias/CVU) -> se conserva desligado para que la
 *    conciliación tardía siga buscando una transferencia (no bloquea nada).
 * 4. Nunca llegó a ver los datos bancarios -> se da de baja.
 *
 * Pedido, payment claim y reserva de ambos intentos quedan separados.
 */
export async function retireExpiredTransferAttempt(
  admin: AdminClient,
  order: PendingCheckoutOrderRow,
  {
    customerCheckoutFingerprint,
    currentEconomicFingerprint,
    now = new Date(),
  }: { customerCheckoutFingerprint: string; currentEconomicFingerprint: string; now?: Date },
): Promise<RetireExpiredTransferAttemptResult> {
  const evidence = hasTransferPaymentEvidence(order)
  const payerDeclared = Boolean(order.transfer_payer_dni) || order.transfer_amount_declared != null

  if (!evidence && (holdsCustomerCreditOrBenefit(order) || !payerDeclared)) {
    return cancelTransferAttemptWithoutPayment(admin, order, {
      reason: "reservation_expired",
      currentEconomicFingerprint,
      requireNoVerificationAttempts: false,
      now,
    })
  }

  const { data: detached, error } = await admin
    .from("ordenes")
    .update({ customer_checkout_fingerprint: null } as never)
    .eq("id", order.id)
    .eq("payment_method_id", "transferencia")
    .eq("estado", "pendiente")
    .eq("customer_checkout_fingerprint", customerCheckoutFingerprint)
    .select("id")
    .maybeSingle()

  if (error) {
    throw new Error(error.message || "No se pudo actualizar el pedido anterior.")
  }
  if (!detached) return "busy"

  await appendOrderAuditEvent(admin, {
    orderId: order.id,
    actorType: "system",
    action: "transfer_checkout_detached_after_reservation_expiry",
    previousStatus: order.financial_status ?? "pending_payment",
    newStatus: order.financial_status ?? "pending_payment",
    metadata: {
      reason: "reservation_expired",
      paymentEvidence: evidence,
      detachedAt: now.toISOString(),
    },
  })

  return "detached"
}

/**
 * `checkout_idempotency_key` es único en toda la tabla (no parcial): si la
 * orden reemplazada salió de esta MISMA sesión, la nueva necesita una clave
 * derivada para no chocar para siempre contra la cancelada. Una clave
 * determinística por orden reemplazada conserva la protección contra doble
 * inserción del mismo reintento.
 */
export function getTransferCheckoutIdempotencyKey(
  sessionId: string,
  supersededOrder: Pick<PendingCheckoutOrderRow, "id" | "checkout_idempotency_key"> | null,
) {
  const base = `checkout:${sessionId}`
  return supersededOrder && supersededOrder.checkout_idempotency_key?.startsWith(base)
    ? `${base}:after:${supersededOrder.id}`
    : base
}
