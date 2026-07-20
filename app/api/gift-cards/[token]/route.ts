import { NextResponse } from "next/server"

import { hashGiftCardClaimToken } from "@/lib/customer-gift-cards"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

interface RouteContext {
  params: Promise<{ token: string }>
}

function giftCardError(error: string) {
  if (error.includes("GIFT_CARD_ALREADY_CLAIMED")) return "Esta Gift Card ya fue acreditada."
  if (error.includes("GIFT_CARD_EXPIRED")) return "Esta Gift Card está vencida."
  if (error.includes("GIFT_CARD_NOT_AVAILABLE")) return "Esta Gift Card ya no está disponible."
  return "No pudimos acreditar la Gift Card. Intentá nuevamente."
}

export async function GET(_request: Request, context: RouteContext) {
  const { token } = await context.params
  if (!token || token.length < 32) {
    return NextResponse.json({ error: "El enlace de la Gift Card no es válido." }, { status: 404 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from("customer_gift_cards")
    .select("id, recipient_name, sender_name, initial_amount, message, display_code, status, expires_at")
    .eq("claim_token_hash", hashGiftCardClaimToken(token))
    .maybeSingle()

  if (error || !data) {
    return NextResponse.json({ error: "El enlace de la Gift Card no es válido." }, { status: 404 })
  }

  const expired = data.status === "sent" && new Date(data.expires_at).getTime() <= Date.now()
  return NextResponse.json({
    giftCard: {
      ...data,
      status: expired ? "expired" : data.status,
    },
  }, { headers: { "Cache-Control": "private, no-store" } })
}

export async function POST(_request: Request, context: RouteContext) {
  const { token } = await context.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.email) {
    return NextResponse.json({ error: "Iniciá sesión para recibir tu Gift Card." }, { status: 401 })
  }

  const admin = createAdminClient()
  const { data: giftCard } = await admin
    .from("customer_gift_cards")
    .select("id, recipient_email, status")
    .eq("claim_token_hash", hashGiftCardClaimToken(token))
    .maybeSingle()

  if (!giftCard) {
    return NextResponse.json({ error: "El enlace de la Gift Card no es válido." }, { status: 404 })
  }

  if (giftCard.recipient_email.toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "Esta Gift Card fue enviada a otro email. Ingresá con la cuenta destinataria." },
      { status: 403 },
    )
  }

  if (giftCard.status === "claimed") {
    return NextResponse.json({ claimed: true, alreadyClaimed: true })
  }

  const { data, error } = await admin.rpc("claim_customer_gift_card", {
    p_gift_card_id: giftCard.id,
    p_recipient_user_id: user.id,
  })

  if (error) {
    return NextResponse.json({ error: giftCardError(error.message) }, { status: 400 })
  }

  return NextResponse.json({
    claimed: true,
    balance: Number(data?.[0]?.resulting_balance ?? 0),
  })
}
