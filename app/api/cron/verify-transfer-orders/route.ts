import { NextResponse } from "next/server"

import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { retryPendingTransferVerifications } from "@/lib/orders/transfer-verification-retry"
import { createAdminClient } from "@/lib/supabase/admin"

export async function GET(request: Request) {
  // Falla cerrado: sin CRON_SECRET configurado este endpoint podría ser
  // invocado por cualquiera para gastar la cuota de la API de Mercado Pago.
  if (
    !isCronRequestAuthorized(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const result = await retryPendingTransferVerifications(createAdminClient())

  return NextResponse.json({ ok: true, ...result })
}
