import { createAdminClient } from "@/lib/supabase/admin"

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
    { headers: mercadoPagoHeaders(), cache: "no-store" },
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
    { headers: mercadoPagoHeaders(), cache: "no-store" },
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
    const nextStatus = ["cancelled", "rejected"].includes(payment.status)
      ? "rechazado"
      : topup.status
    const { error: updateError } = await admin
      .from("customer_credit_topups")
      .update({
        status: topup.status === "acreditado" ? "acreditado" : nextStatus,
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

  return {
    credited: true,
    topup: Array.isArray(data) ? data[0] : data,
    paymentStatus: payment.status,
  }
}
