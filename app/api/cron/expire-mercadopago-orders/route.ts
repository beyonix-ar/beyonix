import { NextResponse } from "next/server"

import { expireAbandonedMercadoPagoOrders } from "@/lib/orders/mercadopago-expiration"
import { createAdminClient } from "@/lib/supabase/admin"

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const authorization = request.headers.get("authorization")

  if (!cronSecret) {
    return NextResponse.json(
      { error: "La tarea programada no está configurada." },
      { status: 503 },
    )
  }

  if (authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const admin = createAdminClient()
  const expired = await expireAbandonedMercadoPagoOrders(admin)

  // El historial público de cargas es de sólo lectura. Expirar los checkouts
  // antiguos acá evita que una consulta GET modifique el saldo del cliente.
  const now = new Date()
  const { error: topupError } = await admin
    .from("customer_credit_topups")
    .update({
      status: "cancelado",
      mercadopago_status: "checkout_expired",
      updated_at: now.toISOString(),
    })
    .eq("payment_method", "mercadopago")
    .eq("status", "pendiente_pago")
    .lt("created_at", new Date(now.getTime() - 45 * 60 * 1000).toISOString())

  if (topupError) {
    console.error("CUSTOMER_CREDIT_TOPUP_EXPIRATION_FAILED", {
      code: topupError.code,
    })
    return NextResponse.json({ error: "No se pudieron expirar las cargas." }, { status: 500 })
  }

  return NextResponse.json({ ok: true, expired })
}
