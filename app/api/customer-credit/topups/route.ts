import { NextResponse } from "next/server"

import {
  getPaymentProofValidationError,
  sanitizePaymentProofFileName,
} from "@/lib/payments/transfer"
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

  // Una preferencia de Mercado Pago vence a los 30 minutos. Si el navegador
  // se cerró y no pudo avisar el abandono, la cerramos al volver a consultar
  // el historial para que no permanezca como pendiente indefinidamente.
  const expiredCheckoutCutoff = new Date(
    Date.now() - 45 * 60 * 1000,
  ).toISOString()
  await admin
    .from("customer_credit_topups")
    .update({
      status: "cancelado",
      mercadopago_status: "checkout_expired",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id)
    .eq("payment_method", "mercadopago")
    .eq("status", "pendiente_pago")
    .lt("created_at", expiredCheckoutCutoff)

  const { data, error, count } = await admin
    .from("customer_credit_topups")
    .select(TOPUP_SELECT, { count: "exact" })
    .eq("user_id", user.id)
    .neq("status", "cancelado")
    .order("created_at", { ascending: false })
    .range(from, to)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
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

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const formData = await request.formData()
  const file = formData.get("file")
  const replaceTopupIdValue = formData.get("replace_topup_id")
  const replaceTopupId =
    typeof replaceTopupIdValue === "string" ? replaceTopupIdValue.trim() : ""

  if (
    replaceTopupId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      replaceTopupId,
    )
  ) {
    return NextResponse.json({ error: "El comprobante a reemplazar no es válido." }, { status: 400 })
  }

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Subí el comprobante de transferencia." },
      { status: 400 },
    )
  }

  const validationError = getPaymentProofValidationError(file)

  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }

  const admin = createAdminClient()
  const safeName = sanitizePaymentProofFileName(file.name)
  const path = `${user.id}/${Date.now()}-${safeName}`
  const { error: uploadError } = await admin.storage
    .from(TOPUP_PROOF_BUCKET)
    .upload(path, file, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 })
  }

  const storedPath = `${TOPUP_PROOF_BUCKET}/${path}`

  if (replaceTopupId) {
    const { data: previousTopup, error: previousTopupError } = await admin
      .from("customer_credit_topups")
      .select("id, proof_url, status, payment_method")
      .eq("id", replaceTopupId)
      .eq("user_id", user.id)
      .maybeSingle()

    if (
      previousTopupError ||
      !previousTopup ||
      previousTopup.status !== "en_revision" ||
      previousTopup.payment_method !== "transfer"
    ) {
      await admin.storage.from(TOPUP_PROOF_BUCKET).remove([path])
      return NextResponse.json(
        { error: "Este comprobante ya no se puede reemplazar." },
        { status: 409 },
      )
    }

    const { data: replacedTopup, error: replaceError } = await admin
      .from("customer_credit_topups")
      .update({
        proof_url: storedPath,
        proof_file_name: file.name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", replaceTopupId)
      .eq("user_id", user.id)
      .eq("status", "en_revision")
      .eq("payment_method", "transfer")
      .select(TOPUP_SELECT)
      .maybeSingle()

    if (replaceError || !replacedTopup) {
      await admin.storage.from(TOPUP_PROOF_BUCKET).remove([path])
      return NextResponse.json(
        { error: replaceError?.message ?? "No se pudo reemplazar el comprobante." },
        { status: replaceError ? 500 : 409 },
      )
    }

    const previousPath = getProofStoragePath(previousTopup.proof_url)
    if (previousPath && previousPath !== path) {
      await admin.storage.from(TOPUP_PROOF_BUCKET).remove([previousPath])
    }

    return NextResponse.json({
      topup: {
        ...replacedTopup,
        proof_signed_url: await getSignedProofUrl(admin, replacedTopup.proof_url),
      },
    })
  }

  const { data, error } = await admin
    .from("customer_credit_topups")
    .insert({
      user_id: user.id,
      amount: null,
      customer_name: null,
      customer_dni: null,
      proof_url: storedPath,
      proof_file_name: file.name,
      status: "en_revision",
      payment_method: "transfer",
    })
    .select(TOPUP_SELECT)
    .single()

  if (error || !data) {
    await admin.storage.from(TOPUP_PROOF_BUCKET).remove([path])

    return NextResponse.json(
      { error: error?.message ?? "No se pudo registrar la carga." },
      { status: 500 },
    )
  }

  return NextResponse.json({
    topup: {
      ...data,
      proof_signed_url: await getSignedProofUrl(admin, data.proof_url),
    },
  })
}
