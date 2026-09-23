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
  transfer_amount_declared?: number | null
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
 * ¿Se puede dar de baja automáticamente? Sólo si el pedido no tiene NINGÚN
 * rastro de pago: sin comprobante, sin verificación de transferencia
 * iniciada (el cliente puede declarar una transferencia sin comprobante) y
 * sin pago confirmado. Cualquier rastro -> revisión humana, nunca se cancela.
 */
export function isTransferOrderSupersedable(order: PendingCheckoutOrderRow) {
  return (
    order.payment_method_id === "transferencia" &&
    order.estado === "pendiente" &&
    SUPERSEDABLE_TRANSFER_PAYMENT_STATUSES.includes(
      (order.payment_status ?? "") as (typeof SUPERSEDABLE_TRANSFER_PAYMENT_STATUSES)[number],
    ) &&
    [null, undefined, "pending_payment"].includes(order.financial_status) &&
    !order.payment_proof_url &&
    !order.payment_proof_uploaded_at &&
    !order.transfer_verification_status &&
    order.transfer_amount_declared == null
  )
}

export type SupersedeTransferOrderResult = "superseded" | "payment_in_review" | "busy"

/**
 * Da de baja un pedido por transferencia económicamente obsoleto de la misma
 * compra, para que el cliente continúe con el total actual. Cancela (nunca
 * borra) con UPDATE condicional atómico que re-verifica que siga sin ningún
 * rastro de pago; el trigger `release_order_stock_reservation` libera su
 * reserva; se reintegra el saldo y se libera el beneficio de tienda.
 */
export async function supersedeStaleTransferOrder(
  admin: AdminClient,
  order: PendingCheckoutOrderRow,
  {
    currentEconomicFingerprint,
    now = new Date(),
  }: { currentEconomicFingerprint: string; now?: Date },
): Promise<SupersedeTransferOrderResult> {
  if (!isTransferOrderSupersedable(order)) return "payment_in_review"

  const { data: updated, error } = await admin
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
    .is("transfer_verification_status", null)
    .is("transfer_amount_declared", null)
    .select("id")
    .maybeSingle()

  if (error) {
    throw new Error(error.message || "No se pudo actualizar el pedido anterior.")
  }

  // Otro request lo tocó entre la lectura y este UPDATE (comprobante,
  // verificación, otra pestaña): nunca se asume nada.
  if (!updated) return "busy"

  if (Number(order.credit_balance_used ?? 0) > 0) {
    await reverseCustomerCreditForOrder(admin, {
      orderId: order.id,
      description: "Reintegro de saldo: la compra se actualizó con nuevos precios o condiciones",
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
      reason: "economic_conditions_changed",
      previousTotal: order.total ?? null,
      previousExternalAmountDue: order.external_amount_due ?? null,
      previousEconomicFingerprint: order.pricing_snapshot?.economicFingerprint ?? null,
      currentEconomicFingerprint,
    },
  })

  return "superseded"
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
