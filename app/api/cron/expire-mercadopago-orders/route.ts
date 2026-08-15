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

  const expired = await expireAbandonedMercadoPagoOrders(
    createAdminClient(),
  )

  return NextResponse.json({ ok: true, expired })
}
