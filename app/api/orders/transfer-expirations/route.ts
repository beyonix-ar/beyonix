import { NextResponse } from "next/server"

import { expireOverdueTransferOrders } from "@/lib/orders/transfer-expiration"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  await expireOverdueTransferOrders(createAdminClient(), { userId: user.id })

  return NextResponse.json({ ok: true })
}
