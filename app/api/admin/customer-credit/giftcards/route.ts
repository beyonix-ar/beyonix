import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"

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
  metadata?: Record<string, unknown> | null
}

function metadataText(metadata: Record<string, unknown> | null | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === "string" ? value : ""
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request)

  if ("error" in auth) return auth.error

  const { data: movements, error: movementsError } = await auth.admin
    .from("customer_credit_movements")
    .select("id, user_id, movement_type, amount, description, created_at, metadata")
    .in("movement_type", ["credit", "debit"])
    .order("created_at", { ascending: false })
    .limit(120)

  if (movementsError) {
    return NextResponse.json(
      { error: movementsError.message ?? "No se pudo cargar GiftCard." },
      { status: 500 },
    )
  }

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
      status: isDebit ? "debitado" : "acreditado",
      message,
      proof_file_name: null,
      proof_signed_url: null,
      submitted_name: null,
      submitted_dni: null,
    }
  })

  const giftcards = movementItems
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 120)

  return NextResponse.json({ giftcards })
}
