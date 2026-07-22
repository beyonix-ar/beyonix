import { NextResponse } from "next/server"

import {
  findMercadoPagoPaymentByExternalReference,
  processCustomerCreditTopupPayment,
} from "@/lib/mercadopago/customer-credit-topups"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

interface AbandonPayload {
  topupId?: string
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "No autorizado." }, { status: 401 })

    const payload = (await request.json()) as AbandonPayload
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
      .select("id, status, external_reference")
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

    if (["acreditado", "rechazado", "cancelado"].includes(topup.status)) {
      return NextResponse.json({
        ok: true,
        cancelled: topup.status === "cancelado",
        status: topup.status,
      })
    }

    // Nunca cancelamos basándonos solamente en que el navegador volvió atrás:
    // primero consultamos al proveedor por si el pago llegó a generarse.
    const payment = await findMercadoPagoPaymentByExternalReference(
      topup.external_reference,
    )

    if (payment) {
      const result = await processCustomerCreditTopupPayment(payment)
      return NextResponse.json({ ok: true, cancelled: false, ...result })
    }

    const { data: cancelledTopup, error: cancelError } = await admin
      .from("customer_credit_topups")
      .update({
        status: "cancelado",
        mercadopago_status: "checkout_abandoned",
        updated_at: new Date().toISOString(),
      })
      .eq("id", topupId)
      .eq("user_id", user.id)
      .eq("status", "pendiente_pago")
      .select("id")
      .maybeSingle()

    if (cancelError) throw cancelError

    return NextResponse.json({
      ok: true,
      cancelled: Boolean(cancelledTopup),
      status: cancelledTopup ? "cancelado" : "sin_cambios",
    })
  } catch (error) {
    console.error("Error cancelando una carga abandonada de Mercado Pago", error)
    return NextResponse.json(
      { error: "No pudimos verificar el intento de pago abandonado." },
      { status: 500 },
    )
  }
}
