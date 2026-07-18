import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import type { createAdminClient } from "@/lib/supabase/admin"

const TOPUP_PROOF_BUCKET = "customer-credit-topups"
type AdminClient = ReturnType<typeof createAdminClient>

type CreditProfile = {
  id: string
  email?: string | null
  username?: string | null
  nombre?: string | null
  dni?: string | null
  telefono?: string | null
}

type GiftCardTopupRow = {
  id: string
  user_id: string
  amount: number | string
  customer_name?: string | null
  customer_dni?: string | null
  proof_url?: string | null
  proof_file_name?: string | null
  status: string
  created_at: string
}

type GiftCardMovementRow = {
  id: string
  user_id: string
  amount: number | string
  description?: string | null
  created_at: string
  metadata?: Record<string, unknown> | null
}

function metadataText(metadata: Record<string, unknown> | null | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === "string" ? value : ""
}

async function getSignedProofUrl(
  admin: AdminClient,
  proofUrl?: string | null,
) {
  if (!proofUrl) return null

  const path = proofUrl.startsWith(`${TOPUP_PROOF_BUCKET}/`)
    ? proofUrl.slice(TOPUP_PROOF_BUCKET.length + 1)
    : proofUrl
  const { data } = await admin.storage
    .from(TOPUP_PROOF_BUCKET)
    .createSignedUrl(path, 60 * 10)

  return data?.signedUrl ?? null
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request)

  if ("error" in auth) return auth.error

  const [{ data: topups, error: topupsError }, { data: movements, error: movementsError }] =
    await Promise.all([
      auth.admin
        .from("customer_credit_topups")
        .select("id, user_id, amount, customer_name, customer_dni, proof_url, proof_file_name, status, created_at")
        .order("created_at", { ascending: false })
        .limit(80),
      auth.admin
        .from("customer_credit_movements")
        .select("id, user_id, amount, description, created_at, metadata")
        .eq("movement_type", "credit")
        .order("created_at", { ascending: false })
        .limit(120),
    ])

  if (topupsError || movementsError) {
    return NextResponse.json(
      { error: topupsError?.message ?? movementsError?.message ?? "No se pudo cargar GiftCard." },
      { status: 500 },
    )
  }

  const topupRows = (topups ?? []) as GiftCardTopupRow[]
  const movementRows = ((movements ?? []) as GiftCardMovementRow[]).filter(
    (movement) =>
      movement.metadata?.source_kind === "gift_card" &&
      [
        "customer_gift_card",
        "admin_gift_card_transfer",
        "admin_gift_card_panel",
      ].includes(metadataText(movement.metadata, "created_from")),
  )
  const profileIds = [
    ...topupRows.map((topup) => topup.user_id),
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

  const topupItems = await Promise.all(
    topupRows.map(async (topup) => {
      const profile = profiles.get(topup.user_id) ?? null

      return {
        id: `topup:${topup.id}`,
        kind: "topup",
        created_at: topup.created_at,
        origin: profile,
        destination: profile,
        amount: Number(topup.amount ?? 0),
        status: topup.status,
        message: "Carga por transferencia",
        proof_file_name: topup.proof_file_name,
        proof_signed_url: await getSignedProofUrl(auth.admin, topup.proof_url),
        submitted_name: topup.customer_name,
        submitted_dni: topup.customer_dni,
      }
    }),
  )

  const movementItems = movementRows.map((movement) => {
    const metadata = movement.metadata ?? {}
    const originId =
      metadataText(metadata, "sender_user_id") ||
      metadataText(metadata, "source_user_id")
    const origin = originId ? profiles.get(originId) ?? null : null
    const destination = profiles.get(movement.user_id) ?? null
    const message =
      metadataText(metadata, "message") ||
      String(movement.description ?? "")
        .replace(/^GiftCard recibida:\s*/i, "")
        .replace(/^Transferencia GiftCard recibida:\s*/i, "")

    return {
      id: `movement:${movement.id}`,
      kind: "giftcard",
      created_at: movement.created_at,
      origin,
      destination,
      amount: Number(movement.amount ?? 0),
      status: "acreditado",
      message,
      proof_file_name: null,
      proof_signed_url: null,
      submitted_name: null,
      submitted_dni: null,
    }
  })

  const giftcards = [...topupItems, ...movementItems]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 120)

  return NextResponse.json({ giftcards })
}
