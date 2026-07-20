import { NextResponse } from "next/server"

import { normalizeMoney } from "@/lib/customer-credit"
import { getCustomerCreditBalance, listCustomerCreditMovements } from "@/lib/customer-credit/server"
import {
  createGiftCardClaimToken,
  createGiftCardDisplayCode,
  getGiftCardExpirationDate,
  hashGiftCardClaimToken,
  isValidGiftCardEmail,
  normalizeGiftCardEmail,
} from "@/lib/customer-gift-cards"
import { deliverGiftCardEmail } from "@/lib/email/send-gift-card-email"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

function cleanText(value: unknown) {
  return String(value ?? "").trim()
}

function cleanMessage(value: unknown) {
  return String(value ?? "").trim().slice(0, 240)
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const body = (await request.json()) as {
    recipientName?: unknown
    recipientEmail?: unknown
    recipientLookup?: unknown
    amount?: unknown
    message?: unknown
  }

  const recipientName = cleanText(body.recipientName).slice(0, 120)
  const recipientEmail = normalizeGiftCardEmail(
    body.recipientEmail ?? body.recipientLookup,
  )
  const amount = normalizeMoney(body.amount)
  const message = cleanMessage(body.message)

  if (recipientName.length < 3) {
    return NextResponse.json(
      { error: "Ingresá el nombre y apellido del destinatario." },
      { status: 400 },
    )
  }

  if (!recipientEmail) {
    return NextResponse.json(
      { error: "Ingresá el email del destinatario." },
      { status: 400 },
    )
  }

  if (recipientEmail.length > 320 || !isValidGiftCardEmail(recipientEmail)) {
    return NextResponse.json(
      { error: "Ingresá un email válido." },
      { status: 400 },
    )
  }

  if (amount <= 0) {
    return NextResponse.json(
      { error: "Ingresá un monto mayor a cero." },
      { status: 400 },
    )
  }

  const admin = createAdminClient()
  const { data: senderProfile } = await admin
    .from("profiles")
    .select("id, email, nombre, username, dni")
    .eq("id", user.id)
    .maybeSingle()

  const { data: recipientProfile, error: recipientError } = await admin
    .from("profiles")
    .select("id, email, nombre, username, dni")
    .ilike("email", recipientEmail)
    .limit(1)
    .maybeSingle()

  if (recipientError) {
    return NextResponse.json(
      { error: recipientError.message || "No se pudo buscar el destinatario." },
      { status: 500 },
    )
  }

  if (recipientProfile?.id === user.id || user.email?.toLowerCase() === recipientEmail) {
    return NextResponse.json(
      { error: "No podés enviarte una Gift Card a tu propia cuenta." },
      { status: 400 },
    )
  }

  try {
    const currentBalance = await getCustomerCreditBalance(admin, user.id)

    if (currentBalance < amount) {
      return NextResponse.json(
        { error: "No tenés saldo suficiente para enviar esa Gift Card." },
        { status: 400 },
      )
    }

    const senderName = (
      senderProfile?.nombre ||
      senderProfile?.username ||
      user.email?.split("@")[0] ||
      "Cliente BEYONIX"
    ).trim().slice(0, 120)
    const recipientDisplayName = recipientProfile?.nombre || recipientName
    const claimToken = createGiftCardClaimToken()
    const displayCode = createGiftCardDisplayCode()
    const expiresAt = getGiftCardExpirationDate()
    const { data: createdRows, error: createError } = await admin.rpc(
      "create_claimable_customer_gift_card",
      {
        p_sender_user_id: user.id,
        p_recipient_email: recipientEmail,
        p_recipient_name: recipientDisplayName,
        p_sender_name: senderName,
        p_amount: amount,
        p_message: message,
        p_display_code: displayCode,
        p_claim_token_hash: hashGiftCardClaimToken(claimToken),
        p_expires_at: expiresAt,
      },
    )

    if (createError || !createdRows?.length) {
      throw new Error(createError?.message || "No se pudo crear la Gift Card.")
    }

    const giftCardId = String(createdRows[0].gift_card_id)

    if (recipientProfile) {
      const { error: claimError } = await admin.rpc("claim_customer_gift_card", {
        p_gift_card_id: giftCardId,
        p_recipient_user_id: recipientProfile.id,
      })

      if (claimError) {
        const { error: cancelError } = await admin.rpc(
          "cancel_unclaimed_customer_gift_card",
          {
            p_gift_card_id: giftCardId,
            p_reason: "No se pudo acreditar automáticamente la Gift Card",
          },
        )

        if (cancelError) {
          throw new Error(
            "No pudimos acreditar la Gift Card y el reintegro automático quedó pendiente. Contactá a soporte.",
          )
        }

        throw new Error(
          "No pudimos acreditar la Gift Card. El importe fue reintegrado a tu saldo.",
        )
      }
    }

    const emailDelivery = await deliverGiftCardEmail(admin, giftCardId)

    const [balance, movements] = await Promise.all([
      getCustomerCreditBalance(admin, user.id),
      listCustomerCreditMovements(admin, user.id),
    ])

    return NextResponse.json({
      balance,
      movements,
      emailSent: emailDelivery.ok,
      emailStatus: emailDelivery.status,
      emailMessage: emailDelivery.ok
        ? "La Gift Card fue creada y el correo se envió correctamente."
        : "La Gift Card fue creada, pero el correo quedó pendiente. Un administrador puede reintentarlo sin volver a cobrar el importe.",
      creditedImmediately: Boolean(recipientProfile),
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No se pudo enviar la Gift Card.",
      },
      { status: 500 },
    )
  }
}
