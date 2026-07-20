import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { buildGiftCardEmailPreview, deliverGiftCardEmail } from "@/lib/email/send-gift-card-email"

type CreditProfile = {
  id: string
  email?: string | null
  username?: string | null
  nombre?: string | null
  dni?: string | null
  telefono?: string | null
}

type GiftCardMovementRow = {
  id: string
  user_id: string
  movement_type: "credit" | "debit"
  amount: number | string
  description?: string | null
  created_at: string
  expires_at?: string | null
  metadata?: Record<string, unknown> | null
}

type ClaimableGiftCardRow = {
  id: string
  sender_user_id: string
  recipient_user_id?: string | null
  recipient_email: string
  recipient_name: string
  initial_amount: number | string
  message: string
  status: "sent" | "claimed" | "expired" | "cancelled"
  expires_at: string
  created_at: string
  email_status: "pending" | "sending" | "sent" | "error"
  email_sent_at?: string | null
  email_last_attempt_at?: string | null
  email_attempts: number
  email_last_error?: string | null
}

function metadataText(metadata: Record<string, unknown> | null | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === "string" ? value : ""
}

function getGiftCardExpirationDate() {
  const date = new Date()
  date.setUTCFullYear(date.getUTCFullYear() + 1)
  return date.toISOString()
}

function getGiftCardStatus(movement: GiftCardMovementRow) {
  if (movement.movement_type === "debit") return "debitado"
  if (movement.expires_at && new Date(movement.expires_at).getTime() <= Date.now()) {
    return "vencida"
  }

  return "acreditado"
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request)

  if ("error" in auth) return auth.error

  const { data: movements, error: movementsError } = await auth.admin
    .from("customer_credit_movements")
    .select("id, user_id, movement_type, amount, description, created_at, expires_at, metadata")
    .in("movement_type", ["credit", "debit"])
    .order("created_at", { ascending: false })
    .limit(120)

  if (movementsError) {
    return NextResponse.json(
      { error: movementsError.message ?? "No se pudo cargar GiftCard." },
      { status: 500 },
    )
  }

  const { data: claimableCards, error: cardsError } = await auth.admin
    .from("customer_gift_cards")
    .select("id, sender_user_id, recipient_user_id, recipient_email, recipient_name, initial_amount, message, status, expires_at, created_at, email_status, email_sent_at, email_last_attempt_at, email_attempts, email_last_error")
    .order("created_at", { ascending: false })
    .limit(120)

  if (cardsError) {
    return NextResponse.json(
      { error: cardsError.message ?? "No se pudieron cargar las Gift Cards reclamables." },
      { status: 500 },
    )
  }

  const cardRows = (claimableCards ?? []) as ClaimableGiftCardRow[]

  const movementRows = ((movements ?? []) as GiftCardMovementRow[]).filter(
    (movement) => {
      const createdFrom = metadataText(movement.metadata, "created_from")
      const isGiftCardMovement =
        movement.metadata?.source_kind === "gift_card" &&
        [
        "customer_gift_card",
        "admin_gift_card_transfer",
        "admin_gift_card_panel",
        ].includes(createdFrom)

      if (!isGiftCardMovement) return false

      // Las transferencias ya se representan con su acreditación de destino.
      // Solo sumamos débitos independientes realizados desde el panel admin.
      return (
        movement.movement_type === "credit" ||
        createdFrom === "admin_gift_card_panel"
      )
    },
  )
  const profileIds = [
    ...movementRows.map((movement) => movement.user_id),
    ...movementRows.map((movement) => metadataText(movement.metadata, "sender_user_id")),
    ...movementRows.map((movement) => metadataText(movement.metadata, "source_user_id")),
    ...cardRows.map((card) => card.sender_user_id),
    ...cardRows.map((card) => card.recipient_user_id ?? ""),
  ].filter(Boolean)
  const uniqueProfileIds = [...new Set(profileIds)]
  const profiles = new Map<string, CreditProfile>()

  if (uniqueProfileIds.length) {
    const { data: profileRows } = await auth.admin
      .from("profiles")
      .select("id, email, username, nombre, dni, telefono")
      .in("id", uniqueProfileIds)

    for (const profile of (profileRows ?? []) as CreditProfile[]) {
      profiles.set(profile.id, profile)
    }
  }

  const movementItems = movementRows.map((movement) => {
    const metadata = movement.metadata ?? {}
    const isDebit = movement.movement_type === "debit"
    const originId =
      metadataText(metadata, "sender_user_id") ||
      metadataText(metadata, "source_user_id")
    const movementProfile = profiles.get(movement.user_id) ?? null
    const origin = isDebit
      ? movementProfile
      : originId
        ? profiles.get(originId) ?? null
        : null
    const destination = isDebit ? null : movementProfile
    const message =
      metadataText(metadata, "message") ||
      String(movement.description ?? "")
        .replace(/^GiftCard recibida:\s*/i, "")
        .replace(/^Transferencia GiftCard recibida:\s*/i, "")

    return {
      id: `movement:${movement.id}`,
      kind: "giftcard",
      movement_type: movement.movement_type,
      created_at: movement.created_at,
      origin,
      destination,
      amount: Number(movement.amount ?? 0),
      status: getGiftCardStatus(movement),
      expires_at: movement.expires_at ?? null,
      message,
      proof_file_name: null,
      proof_signed_url: null,
      submitted_name: null,
      submitted_dni: null,
      email_status: null,
      email_sent_at: null,
      email_last_attempt_at: null,
      email_attempts: 0,
      email_last_error: null,
    }
  })

  const claimableItems = cardRows.map((card) => {
    const effectiveStatus =
      card.status === "sent" && new Date(card.expires_at).getTime() <= Date.now()
        ? "expired"
        : card.status

    return {
    id: `card:${card.id}`,
    kind: "giftcard",
    movement_type: effectiveStatus === "claimed" ? "credit" as const : "debit" as const,
    created_at: card.created_at,
    origin: profiles.get(card.sender_user_id) ?? null,
    destination: card.recipient_user_id
      ? profiles.get(card.recipient_user_id) ?? null
      : null,
    amount: Number(card.initial_amount ?? 0),
    status: effectiveStatus === "sent"
      ? "pendiente de acreditación"
      : effectiveStatus === "claimed"
        ? "acreditada"
        : effectiveStatus === "expired"
          ? "vencida"
          : "cancelada",
    expires_at: card.expires_at,
    message: card.message,
    proof_file_name: null,
    proof_signed_url: null,
    submitted_name: `${card.recipient_name} · ${card.recipient_email}`,
    submitted_dni: null,
    email_status: card.email_status,
    email_sent_at: card.email_sent_at ?? null,
    email_last_attempt_at: card.email_last_attempt_at ?? null,
    email_attempts: Number(card.email_attempts ?? 0),
    email_last_error: card.email_last_error ?? null,
    }
  })

  const claimableIds = new Set(cardRows.map((card) => card.id))
  const legacyMovementItems = movementItems.filter((item) => {
    const movement = movementRows.find((row) => `movement:${row.id}` === item.id)
    const giftCardId = metadataText(movement?.metadata, "gift_card_id")
    return !giftCardId || !claimableIds.has(giftCardId)
  })

  const giftcards = [...claimableItems, ...legacyMovementItems]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 120)

  return NextResponse.json({ giftcards })
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const body = (await request.json()) as { action?: unknown; giftCardId?: unknown }
  const action = typeof body.action === "string" ? body.action : ""
  const rawId = typeof body.giftCardId === "string" ? body.giftCardId.trim() : ""
  const giftCardId = rawId.replace(/^card:/, "")

  if (!giftCardId || !["preview", "retry"].includes(action)) {
    return NextResponse.json(
      { error: "Indicá una Gift Card y una acción válida." },
      { status: 400 },
    )
  }

  try {
    if (action === "preview") {
      return NextResponse.json(await buildGiftCardEmailPreview(auth.admin, giftCardId))
    }

    const result = await deliverGiftCardEmail(auth.admin, giftCardId)
    return NextResponse.json(result, { status: result.ok ? 200 : 502 })
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "No se pudo procesar el correo de la Gift Card."
    console.error("Admin Gift Card email action failed", {
      giftCardId,
      action,
      error: message,
    })
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request)

  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    movementId?: unknown
  }
  const rawId = typeof body.movementId === "string" ? body.movementId.trim() : ""
  const cardId = rawId.startsWith("card:") ? rawId.replace(/^card:/, "") : ""
  const movementId = cardId ? "" : rawId.replace(/^movement:/, "")

  if (!movementId && !cardId) {
    return NextResponse.json(
      { error: "Indicá la GiftCard a reactivar." },
      { status: 400 },
    )
  }

  if (cardId) {
    const { data: card, error: cardError } = await auth.admin
      .from("customer_gift_cards")
      .select("id, status, credit_movement_id")
      .eq("id", cardId)
      .maybeSingle()

    if (cardError || !card || card.status !== "claimed" || !card.credit_movement_id) {
      return NextResponse.json(
        { error: cardError?.message || "Solo se pueden reactivar Gift Cards acreditadas." },
        { status: 400 },
      )
    }

    const nextExpiresAt = getGiftCardExpirationDate()
    const { error: movementUpdateError } = await auth.admin
      .from("customer_credit_movements")
      .update({ expires_at: nextExpiresAt })
      .eq("id", card.credit_movement_id)

    if (movementUpdateError) {
      return NextResponse.json(
        { error: movementUpdateError.message || "No se pudo reactivar la Gift Card." },
        { status: 500 },
      )
    }

    const { error: cardUpdateError } = await auth.admin
      .from("customer_gift_cards")
      .update({ expires_at: nextExpiresAt, updated_at: new Date().toISOString() })
      .eq("id", cardId)

    if (cardUpdateError) {
      return NextResponse.json(
        { error: cardUpdateError.message || "No se pudo actualizar la Gift Card." },
        { status: 500 },
      )
    }

    return NextResponse.json({ expires_at: nextExpiresAt })
  }

  const { data: movement, error: movementError } = await auth.admin
    .from("customer_credit_movements")
    .select("id, movement_type, metadata")
    .eq("id", movementId)
    .maybeSingle()

  if (movementError) {
    return NextResponse.json(
      { error: movementError.message || "No se pudo leer la GiftCard." },
      { status: 500 },
    )
  }

  const metadata = (movement?.metadata ?? {}) as Record<string, unknown>
  const isGiftCard =
    movement?.movement_type === "credit" &&
    metadata.source_kind === "gift_card"

  if (!movement || !isGiftCard) {
    return NextResponse.json(
      { error: "Solo se pueden reactivar GiftCards acreditadas." },
      { status: 400 },
    )
  }

  const nextExpiresAt = getGiftCardExpirationDate()
  const { error: updateError } = await auth.admin
    .from("customer_credit_movements")
    .update({
      expires_at: nextExpiresAt,
      metadata: {
        ...metadata,
        reactivated_at: new Date().toISOString(),
        reactivated_by: auth.user.id,
      },
    })
    .eq("id", movementId)

  if (updateError) {
    return NextResponse.json(
      { error: updateError.message || "No se pudo reactivar la GiftCard." },
      { status: 500 },
    )
  }

  return NextResponse.json({ expires_at: nextExpiresAt })
}
