import { NextResponse } from "next/server"

import { expireOverdueTransferOrders } from "@/lib/orders/transfer-expiration"
import { createAdminClient } from "@/lib/supabase/admin"

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const authorization = request.headers.get("authorization")

  if (cronSecret && authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const expired = await expireOverdueTransferOrders(createAdminClient())

  return NextResponse.json({ ok: true, expired })
}
