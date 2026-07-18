import { NextResponse } from "next/server"

import {
  getPaymentProofValidationError,
  sanitizePaymentProofFileName,
} from "@/lib/payments/transfer"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { normalizeMoney } from "@/lib/customer-credit"

const TOPUP_PROOF_BUCKET = "customer-credit-topups"

function onlyDigits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "")
}

async function getSignedProofUrl(
  admin: ReturnType<typeof createAdminClient>,
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

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from("customer_credit_topups")
    .select("id, amount, customer_name, customer_dni, proof_url, proof_file_name, status, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(10)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const topups = await Promise.all(
    (data ?? []).map(async (topup) => ({
      ...topup,
      proof_signed_url: await getSignedProofUrl(admin, topup.proof_url),
    })),
  )

  return NextResponse.json({ topups })
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
  const amount = normalizeMoney(formData.get("amount"))
  const customerName = String(formData.get("customerName") ?? "").trim()
  const customerDni = onlyDigits(formData.get("customerDni"))
  const file = formData.get("file")

  if (amount <= 0) {
    return NextResponse.json(
      { error: "Ingresá un monto mayor a cero." },
      { status: 400 },
    )
  }

  if (customerName.length < 3) {
    return NextResponse.json(
      { error: "Ingresá nombre y apellido." },
      { status: 400 },
    )
  }

  if (!/^\d{7,8}$/.test(customerDni)) {
    return NextResponse.json({ error: "Ingresá un DNI válido." }, { status: 400 })
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
  const { data, error } = await admin
    .from("customer_credit_topups")
    .insert({
      user_id: user.id,
      amount,
      customer_name: customerName,
      customer_dni: customerDni,
      proof_url: storedPath,
      proof_file_name: file.name,
      status: "en_revision",
    })
    .select("id, amount, customer_name, customer_dni, proof_url, proof_file_name, status, created_at")
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
