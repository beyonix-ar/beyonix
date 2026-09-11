import { createAdminClient } from "../supabase/admin.ts"

export interface MercadoPagoPaymentFeeDetail {
  type?: string | null
  amount?: number | null
}

export interface MercadoPagoPaymentTransactionDetails {
  net_received_amount?: number | null
  total_paid_amount?: number | null
}

export interface MercadoPagoPayment {
  id: number
  status: string
  status_detail?: string | null
  external_reference?: string | null
  payment_method_id?: string | null
  payment_type_id?: string | null
  date_approved?: string | null
  transaction_amount?: number | null
  transaction_amount_refunded?: number | null
  currency_id?: string | null
  live_mode?: boolean
  metadata?: Record<string, unknown> | null
  /** Cantidad real de cuotas con la que se procesó el pago (costo REAL posterior, distinto del % configurado usado para armar el precio). */
  installments?: number | null
  /** Cargos/comisiones reales que Mercado Pago descuenta de la operación. */
  fee_details?: MercadoPagoPaymentFeeDetail[] | null
  /** Monto bruto pagado y neto recibido/a liquidar, según informa Mercado Pago. */
  transaction_details?: MercadoPagoPaymentTransactionDetails | null
}

interface MercadoPagoSearchResponse {
  results?: MercadoPagoPayment[]
}

export interface CustomerCreditTopupPaymentResult {
  credited: boolean
  duplicated?: boolean
  topup?: unknown
  paymentStatus: string
}

/**
 * Únicos estados de Mercado Pago que representan una devolución REAL del
 * dinero ya acreditado -- deben disparar reverse_customer_credit_topup.
 * Deliberadamente NO incluye:
 * - pending / in_process / authorized / in_mediation: transitorios, nunca
 *   deberían aparecer sobre un topup ya 'acreditado' (ese payment_id ya fue
 *   'approved' antes), pero si llegaran por una notificación fuera de orden
 *   no representan que el dinero se haya ido -- debitar por esto sería un
 *   falso positivo.
 * - cancelled / rejected: en el modelo real de Mercado Pago son estados
 *   PRE-aprobación (un pago nunca pasa de approved a cancelled/rejected).
 *   Si aparecieran sobre un topup ya acreditado sería una anomalía de datos
 *   (entrega fuera de orden, ID reciclado), no una reversa genuina -- se
 *   ignoran sin tocar el saldo en vez de debitar por accidente.
 * Mismo criterio que POST_CONFIRMATION_REVERSAL_STATUSES en el webhook de
 * órdenes (app/api/mercadopago/webhook/route.ts).
 */
export const MERCADOPAGO_TOPUP_REVERSAL_STATUSES = new Set([
  "refunded",
  "charged_back",
])

function getAccessToken() {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN
  if (!accessToken) throw new Error("MERCADOPAGO_ACCESS_TOKEN no configurado")
  return accessToken
}

function mercadoPagoHeaders() {
  return {
    Authorization: `Bearer ${getAccessToken()}`,
    Accept: "application/json",
  }
}

export function isProductionMercadoPagoToken() {
  return getAccessToken().startsWith("APP_USR-")
}

export async function getMercadoPagoPayment(paymentId: string) {
  const normalizedPaymentId = paymentId.trim()
  if (!/^\d+$/.test(normalizedPaymentId)) {
    throw new Error("El identificador del pago no es válido")
  }

  const response = await fetch(
    `https://api.mercadopago.com/v1/payments/${encodeURIComponent(normalizedPaymentId)}`,
    {
      headers: mercadoPagoHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  )

  if (!response.ok) throw new Error(`Mercado Pago respondió ${response.status}`)
  return (await response.json()) as MercadoPagoPayment
}

export async function findMercadoPagoPaymentByExternalReference(
  externalReference: string,
) {
  const params = new URLSearchParams({
    external_reference: externalReference,
    sort: "date_created",
    criteria: "desc",
    limit: "10",
  })
  const response = await fetch(
    `https://api.mercadopago.com/v1/payments/search?${params.toString()}`,
    {
      headers: mercadoPagoHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    },
  )

  if (!response.ok) throw new Error(`Mercado Pago respondió ${response.status}`)
  const payload = (await response.json()) as MercadoPagoSearchResponse
  const matchingPayments = payload.results?.filter(
    (payment) => payment.external_reference === externalReference,
  ) ?? []
  return (
    matchingPayments.find((payment) => payment.status === "approved") ??
    matchingPayments.find((payment) => payment.status === "pending") ??
    matchingPayments[0] ??
    null
  )
}

function assertValidTopupPayment(
  payment: MercadoPagoPayment,
  topupId: string,
  externalReference: string,
  topupUserId: string,
) {
  if (payment.external_reference !== externalReference) {
    throw new Error("La referencia del pago no coincide con la carga")
  }
  if (isProductionMercadoPagoToken() && payment.live_mode !== true) {
    throw new Error("Un pago de prueba no puede acreditar saldo real")
  }
  const metadataTopupId = payment.metadata?.topup_id
  if (metadataTopupId && String(metadataTopupId) !== topupId) {
    throw new Error("Los datos internos del pago no coinciden con la carga")
  }
  const metadataUserId = payment.metadata?.user_id
  if (metadataUserId && String(metadataUserId) !== topupUserId) {
    throw new Error("El titular interno del pago no coincide con la carga")
  }
}

export async function processCustomerCreditTopupPayment(
  payment: MercadoPagoPayment,
): Promise<CustomerCreditTopupPaymentResult> {
  const externalReference = payment.external_reference ?? ""
  if (!externalReference.startsWith("credit-topup:")) {
    throw new Error("El pago no corresponde a una carga de saldo")
  }

  const topupId = externalReference.replace(/^credit-topup:/, "")
  const admin = createAdminClient()
  const { data: topup, error: topupError } = await admin
    .from("customer_credit_topups")
    .select("id, status, user_id, external_reference, mercadopago_payment_id")
    .eq("id", topupId)
    .eq("external_reference", externalReference)
    .eq("payment_method", "mercadopago")
    .maybeSingle()

  if (topupError || !topup) {
    throw new Error(`Carga de saldo ${topupId} no encontrada`)
  }

  assertValidTopupPayment(payment, topupId, externalReference, topup.user_id)

  if (
    payment.status === "approved" &&
    topup.status === "acreditado" &&
    topup.mercadopago_payment_id === String(payment.id)
  ) {
    return { credited: true, duplicated: true, paymentStatus: payment.status }
  }

  if (payment.status !== "approved") {
    // P1: una carga ya acreditada nunca debe quedarse "acreditado" para
    // siempre si Mercado Pago informa después un estado que representa
    // devolución real del dinero (MERCADOPAGO_TOPUP_REVERSAL_STATUSES) --
    // eso dejaba saldo ficticio disponible sin devolución real.
    // reverse_customer_credit_topup debita el monto acreditado (o lo que
    // quede disponible, registrando la diferencia como deuda explícita si
    // el cliente ya lo gastó) de forma transaccional e idempotente. Un
    // estado transitorio/no-reversivo sobre un topup ya acreditado (ver
    // MERCADOPAGO_TOPUP_REVERSAL_STATUSES) nunca debita nada.
    if (topup.status === "acreditado") {
      if (!MERCADOPAGO_TOPUP_REVERSAL_STATUSES.has(payment.status)) {
        return { credited: true, duplicated: true, paymentStatus: payment.status }
      }

      const { data, error } = await admin.rpc("reverse_customer_credit_topup", {
        p_topup_id: topupId,
        p_payment_id: String(payment.id),
        p_payment_status: payment.status,
      })
      if (error) throw error
      return {
        credited: false,
        topup: Array.isArray(data) ? data[0] : data,
        paymentStatus: payment.status,
      }
    }

    const nextStatus = ["cancelled", "rejected"].includes(payment.status)
      ? "rechazado"
      : topup.status
    const { error: updateError } = await admin
      .from("customer_credit_topups")
      .update({
        status: nextStatus,
        mercadopago_payment_id: String(payment.id),
        mercadopago_status: payment.status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", topupId)

    if (updateError) throw updateError
    return { credited: false, paymentStatus: payment.status }
  }

  if (payment.currency_id !== "ARS") {
    throw new Error("La moneda de la carga de saldo no coincide")
  }
  if (Number(payment.transaction_amount_refunded ?? 0) > 0) {
    throw new Error("El pago registra un reintegro y no puede acreditarse")
  }

  const { data, error } = await admin.rpc(
    "credit_customer_credit_topup_from_mercadopago",
    {
      p_topup_id: topupId,
      p_payment_id: String(payment.id),
      p_payment_status: payment.status,
      p_paid_amount: Number(payment.transaction_amount ?? 0),
    },
  )
  if (error) throw error

  const result = Array.isArray(data) ? data[0] : data
  // 'revertido' es terminal: un approved tardío (reentrega fuera de orden)
  // nunca vuelve a acreditar saldo, aunque la RPC responda sin error.
  const reversedAfterTheFact =
    result && typeof result === "object" && "topup_status" in result
      ? (result as { topup_status?: string }).topup_status === "revertido"
      : false

  return {
    credited: !reversedAfterTheFact,
    topup: result,
    paymentStatus: payment.status,
  }
}
