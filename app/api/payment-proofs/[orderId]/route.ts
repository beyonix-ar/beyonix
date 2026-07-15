import { NextResponse } from "next/server"

import { PAYMENT_PROOF_BUCKET } from "@/lib/payments/transfer"
import { expireTransferOrderIfNeeded } from "@/lib/orders/transfer-expiration"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import type { SupabasePedido } from "@/lib/supabase/types"

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
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id && order.usuario_id !== user?.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  const currentOrder = await expireTransferOrderIfNeeded(
    admin,
    order as SupabasePedido,
  )

  if (currentOrder.payment_method_id !== "transferencia") {
    return NextResponse.json(
      { error: "Este pedido no corresponde a transferencia bancaria." },
      { status: 400 },
    )
  }

  if (!currentOrder.payment_proof_url) {
    return NextResponse.json({ order: currentOrder, signedUrl: null })
  }

  const { data, error } = await admin.storage
    .from(PAYMENT_PROOF_BUCKET)
    .createSignedUrl(stripBucket(currentOrder.payment_proof_url), 300)

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
    order: currentOrder,
    signedUrl: data.signedUrl,
    fileName: currentOrder.payment_proof_file_name,
  })
}
