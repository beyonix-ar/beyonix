import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"

const ALLOWED_ORDER_STATUSES = [
  "pendiente",
  "pagado",
  "enviado",
  "en_camino",
  "entregado",
  "cancelado",
]

function normalizeExternalUrl(value: unknown) {
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (!trimmed) return null

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperator(request)

  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)
  const body = (await request.json()) as {
    estado?: unknown
    tracking_number?: unknown
    tracking_url?: unknown
  }
  const estado = String(body.estado ?? "")

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  if (!ALLOWED_ORDER_STATUSES.includes(estado)) {
    return NextResponse.json(
      { error: "Estado del pedido inválido." },
      { status: 400 },
    )
  }

  const trackingNumber =
    typeof body.tracking_number === "string"
      ? body.tracking_number.trim() || null
      : null

  const { data, error } = await auth.admin
    .from("ordenes")
    .update({
      estado,
      ...(estado === "entregado"
        ? { delivered_at: new Date().toISOString() }
        : {}),
      ...(body.tracking_number !== undefined
        ? { tracking_number: trackingNumber }
        : {}),
      ...(body.tracking_url !== undefined
        ? { tracking_url: normalizeExternalUrl(body.tracking_url) }
        : {}),
    })
    .eq("id", orderId)
    .select()
    .single()

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message || "No se pudo actualizar el estado del pedido." },
      { status: 500 },
    )
  }

  return NextResponse.json({ order: data })
}
