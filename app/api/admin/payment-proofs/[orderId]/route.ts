import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { PAYMENT_PROOF_BUCKET } from "@/lib/payments/transfer"

function stripBucket(path: string) {
  return path.startsWith(`${PAYMENT_PROOF_BUCKET}/`)
    ? path.slice(PAYMENT_PROOF_BUCKET.length + 1)
    : path
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const auth = await requireOperator(request)

  if ("error" in auth) return auth.error

  const { orderId } = await params
  const pedidoId = Number(orderId)

  if (!Number.isFinite(pedidoId) || pedidoId <= 0) {
    return NextResponse.json({ error: "Pedido invalido." }, { status: 400 })
  }

  const { data: order, error: orderError } = await auth.admin
    .from("ordenes")
    .select("id, payment_proof_url")
    .eq("id", pedidoId)
    .single()

  if (orderError || !order?.payment_proof_url) {
    return NextResponse.json(
      { error: "El pedido no tiene comprobante cargado." },
      { status: 404 },
    )
  }

  const { data, error } = await auth.admin.storage
    .from(PAYMENT_PROOF_BUCKET)
    .createSignedUrl(stripBucket(order.payment_proof_url), 300)

  if (error || !data?.signedUrl) {
    return NextResponse.json(
      { error: error?.message || "No se pudo abrir el comprobante." },
      { status: 500 },
    )
  }

  return NextResponse.json({ signedUrl: data.signedUrl })
}
