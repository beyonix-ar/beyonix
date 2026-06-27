import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"

const ALLOWED_PAYMENT_STATUSES = [
  "pendiente_comprobante",
  "en_revision",
  "confirmado",
  "rechazado",
]

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperator(request)

  if ("error" in auth) return auth.error

  const { id } = await params
  const pedidoId = Number(id)
  const body = (await request.json()) as { payment_status?: string }
  const paymentStatus = String(body.payment_status ?? "")

  if (!Number.isFinite(pedidoId) || pedidoId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  if (!ALLOWED_PAYMENT_STATUSES.includes(paymentStatus)) {
    return NextResponse.json({ error: "Estado de pago inválido." }, { status: 400 })
  }

  const updatePayload: Record<string, string | null | number> = {
    payment_status: paymentStatus,
    estado: paymentStatus === "confirmado" ? "pagado" : "pendiente",
    paid_at: paymentStatus === "confirmado" ? new Date().toISOString() : null,
  }

  if (paymentStatus === "confirmado") {
    updatePayload.order_change_status = "change_approved"
    updatePayload.order_change_extra_amount = 0
  }

  const { data, error } = await auth.admin
    .from("ordenes")
    .update(updatePayload)
    .eq("id", pedidoId)
    .eq("payment_method_id", "transferencia")
    .select()
    .single()

  if (error || !data) {
    if (error?.code === "PGRST116") {
      return NextResponse.json(
        { error: "Solo los pedidos por transferencia admiten cambios manuales de pago." },
        { status: 400 },
      )
    }

    return NextResponse.json(
      { error: error?.message || "No se pudo actualizar el estado de pago." },
      { status: 500 },
    )
  }

  return NextResponse.json({ order: data })
}
