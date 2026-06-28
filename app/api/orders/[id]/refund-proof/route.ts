import { NextResponse } from "next/server"

import { PAYMENT_PROOF_BUCKET } from "@/lib/payments/transfer"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

function stripBucket(path: string) {
  return path.startsWith(`${PAYMENT_PROOF_BUCKET}/`)
    ? path.slice(PAYMENT_PROOF_BUCKET.length + 1)
    : path
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: order, error } = await admin
    .from("ordenes")
    .select("id, usuario_id, refund_proof_url, refund_proof_file_name")
    .eq("id", orderId)
    .maybeSingle()

  if (error || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id !== user.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  if (!order.refund_proof_url) {
    return NextResponse.json({ signedUrl: null, fileName: null })
  }

  const { data, error: signedError } = await admin.storage
    .from(PAYMENT_PROOF_BUCKET)
    .createSignedUrl(stripBucket(order.refund_proof_url), 300)

  if (signedError || !data?.signedUrl) {
    return NextResponse.json(
      { error: "No se pudo abrir el comprobante de reintegro." },
      { status: 500 },
    )
  }

  return NextResponse.json({
    signedUrl: data.signedUrl,
    fileName: order.refund_proof_file_name,
  })
}
