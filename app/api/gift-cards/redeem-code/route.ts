import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

function normalizeCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase().slice(0, 64)
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) {
    return NextResponse.json({ error: "Iniciá sesión para usar tu Gift Card." }, { status: 401 })
  }

  const body = (await request.json()) as { code?: unknown }
  const code = normalizeCode(body.code)
  if (!/^BX-GIFT-[A-Z0-9-]+$/.test(code)) {
    return NextResponse.json({ error: "Ingresá un código de Gift Card válido." }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: card, error } = await admin
    .from("customer_gift_cards")
    .select("id, recipient_email, recipient_user_id, status, expires_at")
    .eq("display_code", code)
    .maybeSingle()

  if (error || !card) {
    return NextResponse.json({ error: "No encontramos una Gift Card con ese código." }, { status: 404 })
  }
  if (card.recipient_email.toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json({ error: "Esta Gift Card fue enviada a otro email." }, { status: 403 })
  }
  if (card.status === "claimed") {
    if (card.recipient_user_id === user.id) return NextResponse.json({ claimed: true, alreadyClaimed: true })
    return NextResponse.json({ error: "Esta Gift Card ya fue acreditada." }, { status: 400 })
  }
  if (card.status !== "sent" || new Date(card.expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: "Esta Gift Card ya no está disponible." }, { status: 400 })
  }

  const { data, error: claimError } = await admin.rpc("claim_customer_gift_card", {
    p_gift_card_id: card.id,
    p_recipient_user_id: user.id,
  })
  if (claimError) {
    return NextResponse.json({ error: "No pudimos acreditar la Gift Card. Intentá nuevamente." }, { status: 400 })
  }

  return NextResponse.json({ claimed: true, balance: Number(data?.[0]?.resulting_balance ?? 0) })
}

