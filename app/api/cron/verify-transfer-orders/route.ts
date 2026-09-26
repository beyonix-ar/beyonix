import { NextResponse } from "next/server"

import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { detectTransferPaymentsAfterCancellation } from "@/lib/orders/transfer-payment-after-cancellation"
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

  const admin = createAdminClient()
  const result = await retryPendingTransferVerifications(admin)
  // Ventana técnica: transferencias reales que llegaron después de cancelar su
  // pedido sin pago. Sólo se registran para Admin, nunca se confirman.
  const afterCancellation = await detectTransferPaymentsAfterCancellation(admin)

  return NextResponse.json({ ok: true, ...result, afterCancellation })
}
