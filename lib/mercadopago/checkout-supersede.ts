import "server-only"

import { reverseCustomerCreditForOrder } from "../customer-credit/server.ts"
import { restoreStoreBenefitFromSupersededOrder } from "../customer-store-benefits.ts"
import { appendOrderAuditEvent } from "../orders/order-audit.ts"
import type { createAdminClient } from "../supabase/admin.ts"
import {
  MERCADOPAGO_PREFERENCE_CLAIM_TIMEOUT_MINUTES,
  getStaleMercadoPagoAttemptAction,
  type MercadoPagoCheckoutAttemptRow,
} from "./checkout-attempt.ts"
import {
  findMercadoPagoPaymentForOrder,
  mercadoPagoHeaders,
} from "./customer-credit-topups.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export const MERCADOPAGO_SUPERSEDED_PAYMENT_STATUS = "checkout_superseded"

/** Mismos `payment_status` que `claim_mercadopago_order_preference` considera sin pago activo. */
export const MERCADOPAGO_SUPERSEDABLE_PAYMENT_STATUSES = [
  "pending_checkout",
  "preference_created",
  "preference_error",
  "rejected",
  "cancelled",
] as const

const SAFE_PROVIDER_PAYMENT_STATUSES = new Set(["rejected", "cancelled"])
const ANDREANI_IN_PROGRESS_STATUSES = new Set([
  "claimed",
  "reconciliation_required",
  "created",
])

export interface SupersedableMercadoPagoOrder extends MercadoPagoCheckoutAttemptRow {
  created_at?: string | null
  mercadopago_reference?: string | null
  mercadopago_reference_assigned_at?: string | null
  total?: number | null
  external_amount_due?: number | null
  credit_balance_used?: number | null
  mercadopago_preference_id?: string | null
  store_benefit_id?: string | null
  andreani_creation_status?: string | null
  andreani_envio_id?: string | null
  pricing_snapshot?: { economicFingerprint?: string | null } | null
}

export type SupersedeMercadoPagoOrderResult =
  | "superseded"
  | "busy"
  | "payment_in_process"
  | "already_paid"
  | "blocked"

export interface SupersedeMercadoPagoOrderDependencies {
  /** Vence la preferencia en Mercado Pago para que el link viejo deje de aceptar pagos. */
  expirePreference: (preferenceId: string, now: Date) => Promise<void>
  /**
   * Último pago de Mercado Pago que pertenece REALMENTE a esta orden (no sólo
   * con la misma referencia numérica: los ids de orden pueden reutilizarse).
   * Busca por la referencia canónica de la orden (`order:<uuid>`).
   */
  findPayment: (order: SupersedableMercadoPagoOrder) => Promise<{ status: string } | null>
}

/**
 * Vence una preferencia en Mercado Pago (PUT parcial de la API REST: el
 * `Preference.update` del SDK exige reenviar `items`). Cualquier respuesta
 * no-2xx es un error: quien llama NO debe dar de baja la orden si el link
 * viejo pudiera seguir cobrando.
 */
export async function expireMercadoPagoPreference(preferenceId: string, now: Date) {
  const response = await fetch(
    `https://api.mercadopago.com/checkout/preferences/${encodeURIComponent(preferenceId)}`,
    {
      method: "PUT",
      headers: { ...mercadoPagoHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        expires: true,
        expiration_date_to: now.toISOString(),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  )

  if (!response.ok) {
    throw new Error(`Mercado Pago respondió ${response.status} al vencer la preferencia`)
  }
}

export function createMercadoPagoSupersedeDependencies(): SupersedeMercadoPagoOrderDependencies {
  return {
    expirePreference: expireMercadoPagoPreference,
    findPayment: (order) => findMercadoPagoPaymentForOrder(order),
  }
}

/**
 * Da de baja un intento pendiente de Mercado Pago que quedó económicamente
 * obsoleto (cambió precio, envío, fees, cuotas, beneficio, saldo o
 * modalidad), para que la MISMA compra continúe en una orden nueva con los
 * valores actuales. Nunca borra la orden: la cancela con
 * `payment_status='checkout_superseded'`, queda auditada, y el trigger
 * `release_order_stock_reservation` libera su reserva de stock.
 *
 * Orden de operaciones (cada paso cierra una ventana de carrera):
 * 1. Sólo actúa si no hay pago ni generación de preferencia en curso.
 * 2. Vence la preferencia viva en Mercado Pago (el link viejo deja de cobrar).
 * 3. Consulta Mercado Pago: un pago no rechazado/cancelado frena todo.
 * 4. UPDATE condicional atómico (mismo estado que se evaluó; sin claim
 *    vigente). Si otro request ganó la carrera, no se toca nada.
 * 5. Reintegra saldo y libera el beneficio de tienda de esa orden.
 *
 * Si igual llegara un pago aprobado tardío sobre la preferencia vieja, el
 * webhook ya lo trata como `approved_after_cancellation` (auditado, sin
 * resucitar la orden) -- mismo camino que la expiración automática.
 */
export async function supersedeStaleMercadoPagoOrder(
  admin: AdminClient,
  order: SupersedableMercadoPagoOrder,
  {
    dependencies,
    currentEconomicFingerprint,
    now = new Date(),
  }: {
    dependencies: SupersedeMercadoPagoOrderDependencies
    currentEconomicFingerprint: string
    now?: Date
  },
): Promise<SupersedeMercadoPagoOrderResult> {
  const action = getStaleMercadoPagoAttemptAction(order, now)
  if (action !== "supersede") return action

  if (
    ANDREANI_IN_PROGRESS_STATUSES.has(order.andreani_creation_status ?? "") ||
    String(order.andreani_envio_id ?? "").trim()
  ) {
    return "blocked"
  }

  const expiresAt = order.mercadopago_preference_expires_at
    ? new Date(order.mercadopago_preference_expires_at).getTime()
    : Number.NaN
  const preferenceMayStillBeLive =
    Boolean(order.mercadopago_preference_id) &&
    (!Number.isFinite(expiresAt) || expiresAt > now.getTime())

  if (preferenceMayStillBeLive && order.mercadopago_preference_id) {
    try {
      await dependencies.expirePreference(order.mercadopago_preference_id, now)
    } catch (error) {
      console.error("MERCADOPAGO_SUPERSEDE_PREFERENCE_EXPIRE_ERROR", {
        orderId: order.id,
        error,
      })
      return "busy"
    }
  }

  let payment: { status: string } | null
  try {
    payment = await dependencies.findPayment(order)
  } catch (error) {
    console.error("MERCADOPAGO_SUPERSEDE_PAYMENT_LOOKUP_ERROR", {
      orderId: order.id,
      error,
    })
    return "busy"
  }

  if (payment && !SAFE_PROVIDER_PAYMENT_STATUSES.has(payment.status)) {
    return payment.status === "approved" ? "already_paid" : "payment_in_process"
  }

  const cancelledAt = now.toISOString()
  const claimCutoff = new Date(
    now.getTime() - MERCADOPAGO_PREFERENCE_CLAIM_TIMEOUT_MINUTES * 60 * 1000,
  ).toISOString()

  const { data: updated, error: updateError } = await admin
    .from("ordenes")
    .update({
      estado: "cancelado",
      payment_status: MERCADOPAGO_SUPERSEDED_PAYMENT_STATUS,
      financial_status: "cancelled",
      cancelled_at: cancelledAt,
      mercadopago_init_point: null,
      mercadopago_preference_claim_token: null,
      mercadopago_preference_claimed_at: null,
    } as never)
    .eq("id", order.id)
    .eq("payment_method_id", "mercadopago")
    .eq("estado", "pendiente")
    .eq("financial_status", "pending_payment")
    .in("payment_status", [...MERCADOPAGO_SUPERSEDABLE_PAYMENT_STATUSES])
    .is("andreani_envio_id", null)
    .or(
      `mercadopago_preference_claimed_at.is.null,mercadopago_preference_claimed_at.lt."${claimCutoff}"`,
    )
    .select("id")
    .maybeSingle()

  if (updateError) {
    throw new Error(
      updateError.message || "No se pudo actualizar la compra anterior.",
    )
  }

  // Otro request cambió la orden entre la lectura y este UPDATE (claim,
  // webhook, otra pestaña que ya la reemplazó): nunca se asume nada.
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
    action: "mercadopago_checkout_superseded",
    previousStatus: "pending_payment",
    newStatus: "cancelled",
    metadata: {
      reason: "economic_conditions_changed",
      previousTotal: order.total ?? null,
      previousExternalAmountDue: order.external_amount_due ?? null,
      previousEconomicFingerprint: order.pricing_snapshot?.economicFingerprint ?? null,
      currentEconomicFingerprint,
      preferenceExpired: preferenceMayStillBeLive,
    },
  })

  return "superseded"
}
