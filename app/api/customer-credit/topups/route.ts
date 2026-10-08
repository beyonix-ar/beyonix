import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

const TOPUP_PROOF_BUCKET = "customer-credit-topups"
const TOPUPS_PER_PAGE = 10
const TOPUP_SELECT =
  "id, amount, customer_name, customer_dni, proof_url, proof_file_name, status, payment_method, gross_amount, surcharge_percent, surcharge_amount, mercadopago_payment_id, mercadopago_status, created_at"

function getProofStoragePath(proofUrl?: string | null) {
  if (!proofUrl) return null

  return proofUrl.startsWith(`${TOPUP_PROOF_BUCKET}/`)
    ? proofUrl.slice(TOPUP_PROOF_BUCKET.length + 1)
    : proofUrl
}

async function getSignedProofUrl(
  admin: ReturnType<typeof createAdminClient>,
  proofUrl?: string | null,
) {
  if (!proofUrl) return null

  const path = getProofStoragePath(proofUrl)
  if (!path) return null
  const { data } = await admin.storage
    .from(TOPUP_PROOF_BUCKET)
    .createSignedUrl(path, 60 * 10)

  return data?.signedUrl ?? null
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const requestedPage = Number(new URL(request.url).searchParams.get("page") ?? "1")
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const from = (page - 1) * TOPUPS_PER_PAGE
  const to = from + TOPUPS_PER_PAGE - 1
  const admin = createAdminClient()

  const { data, error, count } = await admin
    .from("customer_credit_topups")
    .select(TOPUP_SELECT, { count: "exact" })
    .eq("user_id", user.id)
    .neq("status", "cancelado")
    .order("created_at", { ascending: false })
    .range(from, to)

  if (error) {
    return NextResponse.json({ error: "No pudimos cargar el historial de saldo." }, { status: 500 })
  }

  const topups = await Promise.all(
    (data ?? []).map(async (topup) => ({
      ...topup,
      proof_signed_url: await getSignedProofUrl(admin, topup.proof_url),
    })),
  )

  const total = count ?? 0

  return NextResponse.json({
    topups,
    pagination: {
      page,
      page_size: TOPUPS_PER_PAGE,
      total,
      total_pages: Math.max(1, Math.ceil(total / TOPUPS_PER_PAGE)),
    },
  })
}

// Decisión de negocio: los clientes ya no pueden cargar saldo por ningún
// medio (transferencia, Mercado Pago ni ningún otro). El saldo a favor sólo
// puede acreditarse por gestión interna de BEYONIX (reintegro, devolución,
// compensación, ajuste administrativo -- ver
// app/api/admin/clientes/saldos/route.ts y
// app/api/admin/customer-credit/route.ts). El GET de arriba se deja activo y
// de sólo lectura para que el historial de cargas previas siga siendo
// consultable.
export async function POST() {
  return NextResponse.json(
    {
      error:
        "La carga de saldo por parte del cliente está deshabilitada. El saldo a favor se acredita únicamente por gestión interna de BEYONIX.",
    },
    { status: 410 },
  )
}
