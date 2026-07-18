import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { getCustomerCreditBalance } from "@/lib/customer-credit/server"
import type { createAdminClient } from "@/lib/supabase/admin"

const TOPUP_PROOF_BUCKET = "customer-credit-topups"
type AdminClient = ReturnType<typeof createAdminClient>

type CreditProfile = {
  id: string
  nombre?: string | null
  username?: string | null
  dni?: string | null
  email?: string | null
}

type CreditTopupRow = {
  id: string
  user_id: string
  amount?: number | string | null
  proof_url?: string | null
  proof_file_name?: string | null
  status: string
  admin_notes?: string | null
  created_at: string
}

function normalizeAmount(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/\./g, "").replace(",", "."))
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0
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

  try {
    const [{ data: profiles, error: profilesError }, { data: topups, error: topupsError }] =
      await Promise.all([
        auth.admin
          .from("profiles")
          .select("id, nombre, username, dni, email")
          .eq("rol", "cliente")
          .order("created_at", { ascending: false }),
        auth.admin
          .from("customer_credit_topups")
          .select("id, user_id, amount, proof_url, proof_file_name, status, admin_notes, created_at")
          .eq("status", "en_revision")
          .order("created_at", { ascending: false })
          .limit(100),
      ])

    if (profilesError || topupsError) {
      throw new Error(
        profilesError?.message ??
          topupsError?.message ??
          "No se pudieron cargar los saldos.",
      )
    }

    const profileRows = (profiles ?? []) as CreditProfile[]
    const profileById = new Map(profileRows.map((profile) => [profile.id, profile]))
    const accounts = await Promise.all(
      profileRows.map(async (profile) => ({
        user_id: profile.id,
        balance: await getCustomerCreditBalance(auth.admin, profile.id),
      })),
    )
    const pendingTopups = await Promise.all(
      ((topups ?? []) as CreditTopupRow[]).map(async (topup) => ({
        ...topup,
        profile: profileById.get(topup.user_id) ?? null,
        proof_signed_url: await getSignedProofUrl(auth.admin, topup.proof_url),
      })),
    )

    return NextResponse.json({ accounts, topups: pendingTopups })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No se pudieron cargar los saldos de clientes.",
      },
      { status: 500 },
    )
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request)

  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    topupId?: unknown
    action?: unknown
    amount?: unknown
    notes?: unknown
  }
  const topupId = typeof body.topupId === "string" ? body.topupId.trim() : ""
  const action = body.action === "approve" || body.action === "reject"
    ? body.action
    : null
  const notes = typeof body.notes === "string" ? body.notes.trim() : ""

  if (!topupId || !action) {
    return NextResponse.json(
      { error: "Indicá el comprobante y la acción a realizar." },
      { status: 400 },
    )
  }

  try {
    const amount = action === "approve" ? normalizeAmount(body.amount) : null

    if (action === "approve" && (!amount || amount <= 0)) {
      return NextResponse.json(
        { error: "Ingresá el monto verificado de la transferencia." },
        { status: 400 },
      )
    }

    const { data, error } = await auth.admin.rpc("resolve_customer_credit_topup", {
      p_topup_id: topupId,
      p_action: action,
      p_amount: amount,
      p_admin_notes: notes || null,
      p_resolved_by: auth.user.id,
    })
    if (error) {
      const message = error.message || "No se pudo resolver el comprobante."

      if (message.includes("TOPUP_NOT_FOUND")) {
        return NextResponse.json({ error: "No encontramos el comprobante." }, { status: 404 })
      }
      if (message.includes("TOPUP_ALREADY_RESOLVED")) {
        return NextResponse.json({ error: "Este comprobante ya fue resuelto." }, { status: 409 })
      }
      if (message.includes("INVALID_TOPUP_AMOUNT")) {
        return NextResponse.json(
          { error: "Ingresá el monto verificado de la transferencia." },
          { status: 400 },
        )
      }

      throw new Error(message)
    }

    const result = Array.isArray(data) ? data[0] ?? null : data

    return NextResponse.json({
      status: result?.topup_status ?? (action === "approve" ? "acreditado" : "rechazado"),
      balance: Number(result?.resulting_balance ?? 0),
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No se pudo resolver el comprobante.",
      },
      { status: 500 },
    )
  }
}
