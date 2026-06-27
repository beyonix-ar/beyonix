import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"

const ALLOWED_RETURN_STATUSES = [
  "solicitada",
  "en_revision",
  "aprobada",
  "rechazada",
  "resuelta",
]

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperator(request)

  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)
  const body = (await request.json()) as {
    return_status?: unknown
    return_admin_note?: unknown
  }
  const returnStatus = String(body.return_status ?? "")
  const adminNote =
    typeof body.return_admin_note === "string"
      ? body.return_admin_note.trim().slice(0, 1000)
      : null

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  if (!ALLOWED_RETURN_STATUSES.includes(returnStatus)) {
    return NextResponse.json({ error: "Estado de devolución inválido." }, { status: 400 })
  }

  const finalStatus = returnStatus === "rechazada" || returnStatus === "resuelta"
  const { data, error } = await auth.admin
    .from("ordenes")
    .update({
      return_status: returnStatus,
      return_admin_note: adminNote,
      return_resolved_at: finalStatus ? new Date().toISOString() : null,
    })
    .eq("id", orderId)
    .not("return_status", "is", null)
    .select()
    .single()

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message || "No se pudo actualizar la devolución." },
      { status: 500 },
    )
  }

  return NextResponse.json({ order: data })
}
