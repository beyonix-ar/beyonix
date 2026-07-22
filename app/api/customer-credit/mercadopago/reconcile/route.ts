import { NextResponse } from "next/server"

import {
  findMercadoPagoPaymentByExternalReference,
  getMercadoPagoPayment,
  processCustomerCreditTopupPayment,
} from "@/lib/mercadopago/customer-credit-topups"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

interface ReconcilePayload {
  topupId?: string
  paymentId?: string
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autorizado." }, { status: 401 })

    const payload = (await request.json()) as ReconcilePayload
    const topupId = payload.topupId?.trim() ?? ""
    if (!/^[0-9a-f-]{36}$/i.test(topupId)) {
      return NextResponse.json(
        { error: "La carga informada no es válida." },
        { status: 400 },
      )
    }

    const admin = createAdminClient()
    const { data: topup, error: topupError } = await admin
      .from("customer_credit_topups")
      .select("id, status, external_reference, mercadopago_payment_id")
      .eq("id", topupId)
      .eq("user_id", user.id)
      .eq("payment_method", "mercadopago")
      .maybeSingle()

    if (topupError || !topup?.external_reference) {
      return NextResponse.json(
        { error: "No encontramos esa carga de saldo." },
        { status: 404 },
      )
    }

    const requestedPaymentId = payload.paymentId?.trim()
    const payment = requestedPaymentId
      ? await getMercadoPagoPayment(requestedPaymentId)
      : await findMercadoPagoPaymentByExternalReference(topup.external_reference)

    if (!payment) {
      return NextResponse.json({
        ok: true,
        credited: false,
        paymentStatus: "not_found",
      })
    }

    const result = await processCustomerCreditTopupPayment(payment)
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error("Error reconciliando una carga de Mercado Pago", error)
    return NextResponse.json(
      {
        error: error instanceof Error
          ? error.message
          : "No pudimos verificar el pago con Mercado Pago.",
      },
      { status: 500 },
    )
  }
}
