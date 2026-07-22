import { createHash, randomUUID } from "node:crypto"

import { MercadoPagoConfig, Preference } from "mercadopago"
import { NextResponse } from "next/server"

import { roundMoney } from "@/lib/customer-credit"
import { getSiteSettings } from "@/lib/site-settings"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

interface PreferencePayload {
  amount?: number | string
  expectedSurchargePercent?: number | string
  expectedMinimumAmount?: number | string
}

function normalizeAmount(value: unknown) {
  const parsed = Number(String(value ?? "").replace(",", "."))
  return Number.isFinite(parsed) ? roundMoney(parsed) : 0
}

const MAX_ATTEMPTS_PER_HOUR = 8
const MAX_ATTEMPTS_PER_DAY = 25
const MAX_ATTEMPTS_PER_IP_PER_HOUR = 20
const MAX_GLOBAL_ATTEMPTS_PER_HOUR = 150

function getRequestFingerprint(request: Request) {
  const forwardedIp =
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()

  if (!forwardedIp) return null

  const serverSalt =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.MERCADOPAGO_WEBHOOK_SECRET ||
    "beyonix-customer-credit"

  return createHash("sha256")
    .update(`${forwardedIp}:${serverSalt}`)
    .digest("hex")
}

export async function POST(request: Request) {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET

  if (!accessToken) {
    return NextResponse.json(
      { error: "Mercado Pago no está configurado." },
      { status: 503 },
    )
  }

  if (process.env.NODE_ENV === "production" && !webhookSecret) {
    return NextResponse.json(
      {
        error:
          "Las cargas por Mercado Pago están temporalmente deshabilitadas hasta completar la configuración segura.",
      },
      { status: 503 },
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const payload = (await request.json()) as PreferencePayload
  const amount = normalizeAmount(payload.amount)
  const settings = await getSiteSettings()
  const minimumAmount =
    settings.customerCreditPayments.mercadoPagoMinimumAmount
  const expectedMinimumAmount = normalizeAmount(payload.expectedMinimumAmount)

  if (Math.abs(expectedMinimumAmount - minimumAmount) > 0.01) {
    return NextResponse.json(
      {
        error:
          "El importe mínimo de Mercado Pago cambió. Actualizá la página antes de continuar.",
      },
      { status: 409 },
    )
  }

  if (
    amount < minimumAmount ||
    amount > 9_000_000_000
  ) {
    return NextResponse.json(
      {
        error: `La carga mínima mediante Mercado Pago es de $${minimumAmount.toLocaleString("es-AR")}.`,
      },
      { status: 400 },
    )
  }

  const surchargePercent =
    settings.customerCreditPayments.mercadoPagoSurchargePercent
  const expectedSurchargePercent = normalizeAmount(
    payload.expectedSurchargePercent,
  )

  if (Math.abs(expectedSurchargePercent - surchargePercent) > 0.001) {
    return NextResponse.json(
      {
        error:
          "El recargo de Mercado Pago cambió. Actualizá la página y revisá el nuevo total.",
      },
      { status: 409 },
    )
  }
  const surchargeAmount = roundMoney(amount * (surchargePercent / 100))
  const grossAmount = roundMoney(amount + surchargeAmount)
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  const fallbackSiteUrl = request.headers.get("origin") || "http://localhost:3000"
  const parsedSiteUrl = new URL(configuredSiteUrl || fallbackSiteUrl)

  if (
    process.env.NODE_ENV === "production" &&
    (parsedSiteUrl.protocol !== "https:" ||
      ["localhost", "127.0.0.1"].includes(parsedSiteUrl.hostname))
  ) {
    return NextResponse.json(
      { error: "La URL pública de Mercado Pago no está configurada correctamente." },
      { status: 503 },
    )
  }

  const siteUrl = parsedSiteUrl.origin
  const topupId = randomUUID()
  const externalReference = `credit-topup:${topupId}`
  const admin = createAdminClient()
  const requestFingerprint = getRequestFingerprint(request)

  const now = Date.now()
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const stalePendingCutoff = new Date(now - 60 * 60 * 1000).toISOString()
  const oldCancelledCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Limpieza oportunista: evita acumular intentos sin pago sin depender de un cron.
  await admin
    .from("customer_credit_topups")
    .update({
      status: "cancelado",
      mercadopago_status: "checkout_expired",
      updated_at: new Date().toISOString(),
    })
    .eq("payment_method", "mercadopago")
    .eq("status", "pendiente_pago")
    .lt("created_at", stalePendingCutoff)

  await admin
    .from("customer_credit_topups")
    .delete()
    .eq("payment_method", "mercadopago")
    .eq("status", "cancelado")
    .lt("updated_at", oldCancelledCutoff)

  const ipHourlyQuery = requestFingerprint
    ? admin
        .from("customer_credit_topups")
        .select("id", { count: "exact", head: true })
        .eq("payment_method", "mercadopago")
        .eq("request_fingerprint", requestFingerprint)
        .gte("created_at", oneHourAgo)
    : Promise.resolve({ count: 0 })

  const [
    { count: hourlyAttempts },
    { count: dailyAttempts },
    { count: ipHourlyAttempts },
    { count: globalHourlyAttempts },
  ] = await Promise.all([
    admin
      .from("customer_credit_topups")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("payment_method", "mercadopago")
      .gte("created_at", oneHourAgo),
    admin
      .from("customer_credit_topups")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("payment_method", "mercadopago")
      .gte("created_at", oneDayAgo),
    ipHourlyQuery,
    admin
      .from("customer_credit_topups")
      .select("id", { count: "exact", head: true })
      .eq("payment_method", "mercadopago")
      .gte("created_at", oneHourAgo),
  ])

  if (
    Number(hourlyAttempts ?? 0) >= MAX_ATTEMPTS_PER_HOUR ||
    Number(dailyAttempts ?? 0) >= MAX_ATTEMPTS_PER_DAY ||
    Number(ipHourlyAttempts ?? 0) >= MAX_ATTEMPTS_PER_IP_PER_HOUR ||
    Number(globalHourlyAttempts ?? 0) >= MAX_GLOBAL_ATTEMPTS_PER_HOUR
  ) {
    return NextResponse.json(
      {
        error:
          "Alcanzaste temporalmente el límite de intentos de pago. Esperá antes de volver a intentarlo.",
      },
      {
        status: 429,
        headers: { "Retry-After": "3600" },
      },
    )
  }

  // Solo permitimos una preferencia activa por cliente. Si vuelve a empezar,
  // la anterior queda cancelada; un webhook aprobado todavía puede acreditarla.
  await admin
    .from("customer_credit_topups")
    .update({
      status: "cancelado",
      mercadopago_status: "replaced_by_new_checkout",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id)
    .eq("payment_method", "mercadopago")
    .eq("status", "pendiente_pago")

  const { error: insertError } = await admin
    .from("customer_credit_topups")
    .insert({
      id: topupId,
      user_id: user.id,
      amount,
      customer_name: null,
      customer_dni: null,
      status: "pendiente_pago",
      payment_method: "mercadopago",
      gross_amount: grossAmount,
      surcharge_percent: surchargePercent,
      surcharge_amount: surchargeAmount,
      external_reference: externalReference,
      request_fingerprint: requestFingerprint,
      mercadopago_status: "preference_created",
    })

  if (insertError) {
    if (insertError.code === "23505") {
      return NextResponse.json(
        { error: "Ya tenés un intento de pago activo. Volvé a intentarlo en unos segundos." },
        { status: 429, headers: { "Retry-After": "10" } },
      )
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  try {
    const preference = new Preference(
      new MercadoPagoConfig({ accessToken }),
    )
    const result = await preference.create({
      body: {
        external_reference: externalReference,
        items: [
          {
            id: `customer-credit-${topupId}`,
            title: "Carga de saldo BEYONIX",
            description: `Saldo a acreditar: ${amount} ARS`,
            quantity: 1,
            unit_price: grossAmount,
            currency_id: "ARS",
          },
        ],
        payer: {
          email: user.email,
        },
        back_urls: {
          success: `${siteUrl}/cuenta?tab=cargar-saldo&mp=success&topup=${topupId}`,
          failure: `${siteUrl}/cuenta?tab=cargar-saldo&mp=failure&topup=${topupId}`,
          pending: `${siteUrl}/cuenta?tab=cargar-saldo&mp=pending&topup=${topupId}`,
        },
        auto_return: "approved",
        expires: true,
        expiration_date_from: new Date(now).toISOString(),
        expiration_date_to: new Date(now + 30 * 60 * 1000).toISOString(),
        statement_descriptor: "BEYONIX",
        notification_url: `${siteUrl}/api/mercadopago/webhook?source_news=webhooks`,
        metadata: {
          flow: "customer_credit_topup",
          topup_id: topupId,
          user_id: user.id,
          credited_amount: amount,
          surcharge_amount: surchargeAmount,
        },
      },
    })

    if (!result.init_point || !result.id) {
      throw new Error("Mercado Pago no devolvió una preferencia válida.")
    }

    const { error: updateError } = await admin
      .from("customer_credit_topups")
      .update({
        mercadopago_preference_id: result.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", topupId)

    if (updateError) throw updateError

    return NextResponse.json({
      init_point: result.init_point,
      topup_id: topupId,
      amount,
      surcharge_percent: surchargePercent,
      surcharge_amount: surchargeAmount,
      total: grossAmount,
    })
  } catch (error) {
    await admin
      .from("customer_credit_topups")
      .update({
        status: "cancelado",
        mercadopago_status: "preference_error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", topupId)

    console.error("Error creando carga de saldo en Mercado Pago", error)
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos iniciar el pago con Mercado Pago.",
      },
      { status: 500 },
    )
  }
}
