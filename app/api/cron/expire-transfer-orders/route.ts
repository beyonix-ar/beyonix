import { NextResponse } from "next/server"

import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { expireOverdueTransferOrders } from "@/lib/orders/transfer-expiration"
import { createAdminClient } from "@/lib/supabase/admin"

export async function GET(request: Request) {
  // Falla cerrado: sin CRON_SECRET configurado este endpoint cancela órdenes
  // de cualquiera que lo invoque.
  if (
    !isCronRequestAuthorized(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const expired = await expireOverdueTransferOrders(createAdminClient())

  return NextResponse.json({ ok: true, expired })
}
