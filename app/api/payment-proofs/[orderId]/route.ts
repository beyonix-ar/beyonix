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
  { params }: { params: Promise<{ orderId: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const { orderId } = await params
  const pedidoId = Number(orderId)

  if (!Number.isFinite(pedidoId) || pedidoId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("*")
    .eq("id", pedidoId)
    .eq("usuario_id", user.id)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.payment_method_id !== "transferencia") {
    return NextResponse.json(
      { error: "Este pedido no corresponde a transferencia bancaria." },
      { status: 400 },
    )
  }

  if (!order.payment_proof_url) {
    return NextResponse.json({ order, signedUrl: null })
  }

  const { data, error } = await admin.storage
    .from(PAYMENT_PROOF_BUCKET)
    .createSignedUrl(stripBucket(order.payment_proof_url), 300)

  if (error || !data?.signedUrl) {
    console.error("customer payment proof signed URL error", {
      orderId: pedidoId,
      message: error?.message || "No se generó la URL firmada.",
    })

    return NextResponse.json(
      { error: "No se pudo abrir el comprobante." },
      { status: 500 },
    )
  }

  return NextResponse.json({
    order,
    signedUrl: data.signedUrl,
    fileName: order.payment_proof_file_name,
  })
}
