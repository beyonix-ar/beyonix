import { NextResponse } from "next/server"

import { AndreaniError, normalizeAndreaniError } from "@/lib/andreani/client"
import { createAndreaniShipmentForOrder } from "@/lib/andreani/order-shipment"
import { requireInternalUser } from "@/lib/auth/admin-api"

function statusForAndreaniError(error: AndreaniError) {
  switch (error.code) {
    case "VALIDATION_ERROR":
      return 400
    case "CONFIGURATION_ERROR":
    case "PRODUCTION_BLOCKED":
      return 503
    default:
      return 502
  }
}

export async function POST(request: Request) {
  const authorization = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in authorization) return authorization.error

  let body: { pedidoId?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Solicitud inválida." }, { status: 400 })
  }

  const orderId = Number(body.pedidoId)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ ok: false, error: "Pedido inválido." }, { status: 400 })
  }

  try {
    const result = await createAndreaniShipmentForOrder(authorization.admin, orderId)

    return NextResponse.json({
      ok: true,
      message:
        result.status === "reused"
          ? `El pedido ya tenía un envío Andreani generado (${result.envioId}).`
          : `Envío Andreani generado correctamente (${result.envioId}).`,
      envioId: result.envioId,
      tracking: result.tracking,
      estado: result.estado,
    })
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    console.error("ANDREANI_CREAR_ENVIO_ERROR", {
      orderId,
      code: safeError.code,
      status: safeError.status,
    })

    const status =
      error instanceof AndreaniError ? statusForAndreaniError(error) : 502

    return NextResponse.json(
      { ok: false, error: safeError.message },
      { status },
    )
  }
}
