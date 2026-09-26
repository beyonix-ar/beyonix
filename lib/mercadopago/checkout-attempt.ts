import "server-only"

import { createHash } from "node:crypto"

import { isMercadoPagoOrderAlreadyConfirmed } from "./order-payment.ts"
import {
  stableStringify,
  type CheckoutEconomicState,
} from "../pricing/checkout-pricing.ts"

export const MERCADOPAGO_PREFERENCE_LIFETIME_MINUTES = 30
export const MERCADOPAGO_PREFERENCE_CLAIM_TIMEOUT_MINUTES = 5
export const MERCADOPAGO_ABANDONED_ORDER_GRACE_HOURS = 24

export const MERCADOPAGO_MAX_ATTEMPTS_PER_HOUR = 8
export const MERCADOPAGO_MAX_ATTEMPTS_PER_DAY = 25
export const MERCADOPAGO_MAX_ATTEMPTS_PER_IP_PER_HOUR = 20
export const MERCADOPAGO_MAX_GLOBAL_ATTEMPTS_PER_HOUR = 150

/**
 * Identidad de un intento de pago: sesión/pestaña + cliente + datos de
 * contacto + ESTADO ECONÓMICO completo (`createCheckoutEconomicFingerprint`).
 * La versión 1 sólo incluía `productsTotal` y el envío: un cambio de fee de
 * Mercado Pago, cuotas máximas, IVA o transferencia dejaba la misma huella y
 * reutilizaba una preferencia creada con otro total.
 */
export interface MercadoPagoCheckoutFingerprintInput {
  sessionId: string
  userId: string | null
  customer: Record<string, string | null>
  economicFingerprint: string
}

export interface MercadoPagoCheckoutAttemptRow {
  id: number
  estado: string
  financial_status?: string | null
  payment_status?: string | null
  payment_method_id?: string | null
  mercadopago_checkout_fingerprint?: string | null
  mercadopago_init_point?: string | null
  mercadopago_preference_expires_at?: string | null
  mercadopago_preference_claimed_at?: string | null
  installments_count?: number | null
}

/**
 * Qué hacer con una orden pendiente del mismo cliente+carrito cuyas
 * condiciones económicas ya NO son las actuales:
 * - `supersede`: sin pago activo -> se cancela y se crea un intento nuevo.
 * - `busy`: hay un pago/claim en curso -> esperar, nunca cancelar.
 * - `already_paid`: ya se pagó -> bloquear.
 * - `blocked`: estado no reutilizable ni cancelable automáticamente.
 * Reutiliza exactamente la misma clasificación que
 * `getMercadoPagoCheckoutAttemptDecision` (una preferencia viva que en el
 * caso equivalente se reutilizaría, acá se da de baja).
 */
export type PendingCustomerCheckoutOrderAction =
  | "other_payment_method"
  | "resume_equivalent"
  | "supersede_stale"

/**
 * Orden pendiente del mismo cliente+carrito (índice de
 * `customer_checkout_fingerprint`, que NO incluye precios): sólo se retoma
 * si su huella económica es idéntica a la actual (dos pestañas, reintento
 * sin cambios). Cualquier diferencia económica -> se reemplaza.
 */
export function getPendingCustomerCheckoutOrderAction(
  order: {
    payment_method_id?: string | null
    pricing_snapshot?: { economicFingerprint?: string | null } | null
  },
  currentEconomicFingerprint: string,
): PendingCustomerCheckoutOrderAction {
  if (order.payment_method_id !== "mercadopago") return "other_payment_method"

  return isEconomicallyEquivalentAttempt(order, currentEconomicFingerprint)
    ? "resume_equivalent"
    : "supersede_stale"
}

export type StaleMercadoPagoAttemptAction =
  | "supersede"
  | "busy"
  | "already_paid"
  | "blocked"

export function getStaleMercadoPagoAttemptAction(
  order: MercadoPagoCheckoutAttemptRow,
  now = new Date(),
): StaleMercadoPagoAttemptAction {
  const decision = getMercadoPagoCheckoutAttemptDecision(order, now)

  switch (decision.kind) {
    case "already_paid":
      return "already_paid"
    case "in_progress":
      return "busy"
    case "reuse":
    case "claim_preference":
      return "supersede"
    default:
      return "blocked"
  }
}

export type MercadoPagoCheckoutAttemptDecision =
  | { kind: "already_paid" }
  | { kind: "reuse"; initPoint: string }
  | { kind: "in_progress" }
  | { kind: "claim_preference" }
  | { kind: "unavailable" }

export function normalizeMercadoPagoCheckoutSessionId(value: unknown) {
  if (typeof value !== "string") return null

  const sessionId = value.trim()
  return sessionId.length >= 8 && sessionId.length <= 160
    ? sessionId
    : null
}

export function createMercadoPagoCheckoutFingerprint(
  input: MercadoPagoCheckoutFingerprintInput,
) {
  return createHash("sha256")
    .update(
      stableStringify({
        version: 2,
        sessionId: input.sessionId,
        userId: input.userId,
        customer: input.customer,
        economicFingerprint: input.economicFingerprint,
      }),
    )
    .digest("hex")
}

export const CHECKOUT_ECONOMIC_FINGERPRINT_PREFIX = "checkout-economics:v2:"

/**
 * Hash determinístico del estado económico canónico
 * (`buildCheckoutEconomicState`). Se persiste en
 * `pricing_snapshot.economicFingerprint` y es la ÚNICA condición bajo la
 * cual una orden pendiente puede reutilizarse: si difiere, las condiciones
 * comerciales cambiaron y el intento previo queda obsoleto.
 */
export function createCheckoutEconomicFingerprint(state: CheckoutEconomicState) {
  return `${CHECKOUT_ECONOMIC_FINGERPRINT_PREFIX}${createHash("sha256")
    .update(stableStringify(state))
    .digest("hex")}`
}

export function getOrderEconomicFingerprint(order: {
  pricing_snapshot?: { economicFingerprint?: string | null } | null
}) {
  const value = order.pricing_snapshot?.economicFingerprint
  return typeof value === "string" &&
    value.startsWith(CHECKOUT_ECONOMIC_FINGERPRINT_PREFIX)
    ? value
    : null
}

/**
 * ¿La orden pendiente fue creada exactamente bajo las condiciones económicas
 * actuales? Órdenes sin huella económica (anteriores a esta versión) nunca
 * se consideran equivalentes: no hay forma de demostrar que su total siga
 * vigente.
 */
export function isEconomicallyEquivalentAttempt(
  order: { pricing_snapshot?: { economicFingerprint?: string | null } | null },
  currentEconomicFingerprint: string,
) {
  return getOrderEconomicFingerprint(order) === currentEconomicFingerprint
}

export function getMercadoPagoCheckoutIdempotencyKey(
  fingerprint: string,
  previousAttemptId?: number | null,
) {
  const retrySuffix = previousAttemptId
    ? `:retry-after:${previousAttemptId}`
    : ""

  return `mercadopago-checkout:v1:${fingerprint}${retrySuffix}`
}

export function getMercadoPagoPreferenceExpiration(now = new Date()) {
  return new Date(
    now.getTime() +
      MERCADOPAGO_PREFERENCE_LIFETIME_MINUTES * 60 * 1000,
  )
}

/** The preference inherits the Step 3 deadline; choosing MP never restarts it. */
export function getMercadoPagoReservationPreferenceExpiration(
  reservationExpiresAt: string,
  now = new Date(),
): Date | null {
  const expiry = new Date(reservationExpiresAt)
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() - now.getTime() < 60_000) {
    return null
  }
  return expiry
}

export function getMercadoPagoRequestFingerprint(request: Request) {
  const forwardedIp =
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()

  if (!forwardedIp) return null

  const serverSalt =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.MERCADOPAGO_WEBHOOK_SECRET ||
    "beyonix-mercadopago-checkout"

  return createHash("sha256")
    .update(`${forwardedIp}:${serverSalt}`)
    .digest("hex")
}

export function getMercadoPagoCheckoutAttemptDecision(
  order: MercadoPagoCheckoutAttemptRow,
  now = new Date(),
): MercadoPagoCheckoutAttemptDecision {
  if (order.payment_method_id !== "mercadopago") {
    return { kind: "unavailable" }
  }

  if (isMercadoPagoOrderAlreadyConfirmed(order)) {
    return { kind: "already_paid" }
  }

  if (
    order.estado !== "pendiente" ||
    ![null, undefined, "pending_payment"].includes(order.financial_status)
  ) {
    return { kind: "unavailable" }
  }

  const expiresAt = order.mercadopago_preference_expires_at
    ? new Date(order.mercadopago_preference_expires_at).getTime()
    : Number.NaN

  if (
    order.mercadopago_init_point &&
    Number.isFinite(expiresAt) &&
    expiresAt > now.getTime()
  ) {
    return {
      kind: "reuse",
      initPoint: order.mercadopago_init_point,
    }
  }

  const claimedAt = order.mercadopago_preference_claimed_at
    ? new Date(order.mercadopago_preference_claimed_at).getTime()
    : Number.NaN
  const claimIsCurrent =
    Number.isFinite(claimedAt) &&
    claimedAt >
      now.getTime() -
        MERCADOPAGO_PREFERENCE_CLAIM_TIMEOUT_MINUTES * 60 * 1000

  if (claimIsCurrent) return { kind: "in_progress" }

  if (
    ["pending", "in_process", "in_mediation", "authorized"].includes(
      order.payment_status ?? "",
    )
  ) {
    return { kind: "in_progress" }
  }

  // "rejected"/"cancelled" llegan acá vía webhook (pago rechazado por el
  // medio de pago, o cancelado desde Checkout Pro) sin que la orden deje de
  // estar `estado='pendiente'` -- el webhook sólo persiste `payment_status`
  // en ese camino (ver app/api/mercadopago/webhook/route.ts, rama
  // `payment.status !== "approved"`), a propósito, porque un pago puede
  // reintentarse con otro medio sobre la MISMA preferencia. Tratarlos como
  // "unavailable" dejaba la orden bloqueando para siempre cualquier
  // reintento (índice único de `customer_checkout_fingerprint`) pese a que
  // ya no hay ningún pago activo ni dinero real involucrado: son tan
  // reutilizables como una preferencia simplemente vencida.
  if (
    [
      "pending_checkout",
      "preference_created",
      "preference_error",
      "rejected",
      "cancelled",
    ].includes(order.payment_status ?? "pending_checkout")
  ) {
    return { kind: "claim_preference" }
  }

  return { kind: "unavailable" }
}

export function isPostgresUniqueViolation(error: { code?: string } | null) {
  return error?.code === "23505"
}
