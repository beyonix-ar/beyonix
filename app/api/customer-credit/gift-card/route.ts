import { NextResponse } from "next/server"

import { normalizeMoney } from "@/lib/customer-credit"
import {
  createCustomerCreditMovement,
  getCustomerCreditBalance,
  listCustomerCreditMovements,
} from "@/lib/customer-credit/server"
import { sendGiftCardEmail } from "@/lib/email/send-gift-card-email"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

function onlyDigits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "")
}

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
    recipientLookup?: unknown
    amount?: unknown
    message?: unknown
  }

  const recipientName = cleanText(body.recipientName)
  const recipientLookup = cleanText(body.recipientLookup).toLowerCase()
  const recipientDni = onlyDigits(recipientLookup)
  const amount = normalizeMoney(body.amount)
  const message = cleanMessage(body.message)

  if (recipientName.length < 3) {
    return NextResponse.json(
      { error: "Ingresá el nombre y apellido del destinatario." },
      { status: 400 },
    )
  }

  if (!recipientLookup) {
    return NextResponse.json(
      { error: "Ingresá email o DNI del destinatario." },
      { status: 400 },
    )
  }

  if (recipientLookup.includes("@") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientLookup)) {
    return NextResponse.json(
      { error: "Ingresá un email válido." },
      { status: 400 },
    )
  }

  if (!recipientLookup.includes("@") && !/^\d{7,8}$/.test(recipientDni)) {
    return NextResponse.json(
      { error: "Ingresá un DNI válido." },
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

  const recipientQuery = admin
    .from("profiles")
    .select("id, email, nombre, username, dni")
    .eq("rol", "cliente")
    .limit(1)

  const { data: recipientProfile, error: recipientError } = recipientLookup.includes("@")
    ? await recipientQuery.eq("email", recipientLookup).maybeSingle()
    : await recipientQuery.eq("dni", recipientDni).maybeSingle()

  if (recipientError) {
    return NextResponse.json(
      { error: recipientError.message || "No se pudo buscar el destinatario." },
      { status: 500 },
    )
  }

  if (!recipientProfile) {
    return NextResponse.json(
      { error: "No encontramos un cliente con ese email o DNI." },
      { status: 404 },
    )
  }

  if (recipientProfile.id === user.id) {
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

    const giftCardId = crypto.randomUUID()
    const senderName =
      senderProfile?.nombre ||
      senderProfile?.username ||
      user.email?.split("@")[0] ||
      "Cliente BEYONIX"
    const recipientDisplayName = recipientProfile.nombre || recipientName
    const visibleMessage = message || "Gift Card BEYONIX"

    await createCustomerCreditMovement(admin, {
      userId: user.id,
      movementType: "debit",
      amount,
      description: `Gift Card enviada a ${recipientDisplayName}: ${visibleMessage}`,
      sourceType: "admin_adjustment",
      createdBy: user.id,
      metadata: {
        created_from: "customer_gift_card",
        source_kind: "gift_card",
        gift_card_id: giftCardId,
        recipient_user_id: recipientProfile.id,
        recipient_name: recipientDisplayName,
        message,
      },
      sourceKey: `customer-gift-card:${giftCardId}:debit`,
    })

    await createCustomerCreditMovement(admin, {
      userId: recipientProfile.id,
      movementType: "credit",
      amount,
      description: `GiftCard recibida: ${visibleMessage}`,
      sourceType: "admin_adjustment",
      createdBy: user.id,
      metadata: {
        created_from: "customer_gift_card",
        source_kind: "gift_card",
        gift_card_id: giftCardId,
        sender_user_id: user.id,
        sender_name: senderName,
        message,
      },
      sourceKey: `customer-gift-card:${giftCardId}:credit`,
    })

    await sendGiftCardEmail({
      to: recipientProfile.email,
      recipientName: recipientDisplayName,
      senderName,
      amount,
      message,
    })

    const [balance, movements] = await Promise.all([
      getCustomerCreditBalance(admin, user.id),
      listCustomerCreditMovements(admin, user.id),
    ])

    return NextResponse.json({ balance, movements })
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
