import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

function normalizeReason(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export async function POST(
  request: Request,
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
  const body = (await request.json()) as { reason?: unknown }
  const reason = normalizeReason(body.reason)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  if (reason.length < 20) {
    return NextResponse.json(
      { error: "Contanos la falla con al menos 20 caracteres." },
      { status: 400 },
    )
  }

  if (reason.length > 1000) {
    return NextResponse.json(
      { error: "La descripción no puede superar los 1000 caracteres." },
      { status: 400 },
    )
  }

  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("id, usuario_id, estado, return_status")
    .eq("id", orderId)
    .single()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id !== user.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  if (order.estado !== "entregado") {
    return NextResponse.json(
      { error: "La devolución se puede solicitar cuando el pedido figura como entregado." },
      { status: 409 },
    )
  }

  if (order.return_status) {
    return NextResponse.json(
      { error: "Este pedido ya tiene una solicitud de devolución." },
      { status: 409 },
    )
  }

  const requestedAt = new Date().toISOString()
  const { data: updatedOrder, error: updateError } = await admin
    .from("ordenes")
    .update({
      return_status: "solicitada",
      return_reason: reason,
      return_requested_at: requestedAt,
      return_resolved_at: null,
      return_admin_note: null,
    })
    .eq("id", orderId)
    .is("return_status", null)
    .select()
    .single()

  if (updateError || !updatedOrder) {
    return NextResponse.json(
      { error: updateError?.message || "No se pudo crear la solicitud." },
      { status: 500 },
    )
  }

  return NextResponse.json({ order: updatedOrder })
}
