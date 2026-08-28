import "server-only"

import { createHash } from "node:crypto"

import { isMercadoPagoOrderAlreadyConfirmed } from "./order-payment.ts"

export const MERCADOPAGO_PREFERENCE_LIFETIME_MINUTES = 30
export const MERCADOPAGO_PREFERENCE_CLAIM_TIMEOUT_MINUTES = 5
export const MERCADOPAGO_ABANDONED_ORDER_GRACE_HOURS = 24

export const MERCADOPAGO_MAX_ATTEMPTS_PER_HOUR = 8
export const MERCADOPAGO_MAX_ATTEMPTS_PER_DAY = 25
export const MERCADOPAGO_MAX_ATTEMPTS_PER_IP_PER_HOUR = 20
export const MERCADOPAGO_MAX_GLOBAL_ATTEMPTS_PER_HOUR = 150

export interface MercadoPagoCheckoutFingerprintInput {
  sessionId: string
  userId: string | null
  items: Array<{
    productId: number
    quantity: number
    variantId: number | null
    conditionedStockId: string | null
  }>
  customer: Record<string, string | null>
  productsTotal: number
  shipping: {
    provider: string
    type: string
    costReal: number
    costCharged: number
    freeShippingApplied: boolean
    sucursalId?: string | null
  }
  storeBenefitId: string | null
  requestedCredit: number
  installmentsModality: number | null
}

export interface MercadoPagoCheckoutAttemptRow {
  id: number
  estado: string
  financial_status?: string | null
  payment_status?: string | null
  payment_method_id?: string | null
  mercadopago_init_point?: string | null
  mercadopago_preference_expires_at?: string | null
  mercadopago_preference_claimed_at?: string | null
  installments_count?: number | null
}

export type MercadoPagoCheckoutAttemptDecision =
  | { kind: "already_paid" }
  | { kind: "reuse"; initPoint: string }
  | { kind: "in_progress" }
  | { kind: "claim_preference" }
  | { kind: "unavailable" }

function normalizeFingerprintItems(
  items: MercadoPagoCheckoutFingerprintInput["items"],
) {
  return [...items].sort(
    (left, right) =>
      left.productId - right.productId ||
      (left.variantId ?? 0) - (right.variantId ?? 0) ||
      (left.conditionedStockId ?? "").localeCompare(
        right.conditionedStockId ?? "",
      ),
  )
}

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
      JSON.stringify({
        version: 1,
        ...input,
        items: normalizeFingerprintItems(input.items),
      }),
    )
    .digest("hex")
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

  if (
    ["pending_checkout", "preference_created", "preference_error"].includes(
      order.payment_status ?? "pending_checkout",
    )
  ) {
    return { kind: "claim_preference" }
  }

  return { kind: "unavailable" }
}

export function isPostgresUniqueViolation(error: { code?: string } | null) {
  return error?.code === "23505"
}
