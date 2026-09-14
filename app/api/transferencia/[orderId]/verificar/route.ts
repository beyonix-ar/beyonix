import { NextResponse } from "next/server"

import { verifyGuestOrderAccessToken } from "@/lib/orders/guest-order-token"
import { attemptTransferAutoVerification } from "@/lib/orders/transfer-verification-service"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

const MAX_TEXT_LENGTH = 200

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_TEXT_LENGTH) : ""
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    const { orderId } = await params
    const pedidoId = Number(orderId)

    if (!Number.isFinite(pedidoId) || pedidoId <= 0) {
      return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Datos inválidos." }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const firstName = normalizeText(payload.nombre)
    const lastName = normalizeText(payload.apellido)
    const dni = normalizeText(payload.dni)
    const amount = Number(payload.monto)

    if (!firstName || !lastName || !dni) {
      return NextResponse.json(
        { error: "Completá nombre, apellido y DNI." },
        { status: 400 },
      )
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "Indicá el monto transferido." },
        { status: 400 },
      )
    }

    const admin = createAdminClient()
    const { data: order, error: orderError } = await admin
      .from("ordenes")
      .select("id, usuario_id, payment_method_id")
      .eq("id", pedidoId)
      .maybeSingle()

    if (orderError || !order) {
      return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
    }

    if (order.usuario_id) {
      if (order.usuario_id !== user?.id) {
        return NextResponse.json({ error: "No autorizado." }, { status: 403 })
      }
    } else {
      const guestToken = request.headers.get("x-guest-order-token")
      if (!verifyGuestOrderAccessToken(guestToken, pedidoId)) {
        return NextResponse.json({ error: "No autorizado." }, { status: 403 })
      }
    }

    if (order.payment_method_id !== "transferencia") {
      return NextResponse.json(
        { error: "Este pedido no corresponde a transferencia bancaria." },
        { status: 400 },
      )
    }

    const result = await attemptTransferAutoVerification(admin, {
      orderId: pedidoId,
      declared: { firstName, lastName, dni, amount },
    })

    switch (result.status) {
      case "verified":
        return NextResponse.json({ status: "verified", order: result.order })
      case "manual_review":
        return NextResponse.json({
          status: "manual_review",
          message: "No pudimos validar tu transferencia automáticamente.",
          order: result.order,
        })
      case "rate_limited":
        return NextResponse.json({ error: result.message }, { status: 429 })
      case "checking_in_progress":
        return NextResponse.json({ error: result.message }, { status: 409 })
      case "rejected":
      default:
        return NextResponse.json({ error: result.message }, { status: 409 })
    }
  } catch (error) {
    console.error("transfer auto-verification error", error)

    return NextResponse.json(
      { error: "No pudimos verificar tu transferencia." },
      { status: 500 },
    )
  }
}
