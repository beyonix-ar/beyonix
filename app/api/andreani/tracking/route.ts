import { NextResponse } from "next/server"

import { AndreaniError, normalizeAndreaniError } from "@/lib/andreani/client"
import {
  resolveAndreaniTrackingEnvironment,
  syncAndreaniOrderTracking,
  type AndreaniOrderTrackingRow,
} from "@/lib/andreani/order-tracking-sync"
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

const ORDER_TRACKING_SELECT =
  "id, estado, delivered_at, andreani_tracking, andreani_envio_id, andreani_creation_environment, cliente_email, cliente_nombre, tracking_number, tracking_url"

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

  const { data: order, error: orderError } = await authorization.admin
    .from("ordenes")
    .select(ORDER_TRACKING_SELECT)
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ ok: false, error: "No encontramos el pedido." }, { status: 404 })
  }

  const orderRow = order as unknown as AndreaniOrderTrackingRow
  const environment = resolveAndreaniTrackingEnvironment(orderRow)

  try {
    const result = await syncAndreaniOrderTracking(authorization.admin, orderRow, {
      actorType: "admin",
      actorId: authorization.user.id,
    })

    const { snapshot } = result
    const message = snapshot.rejectedAfterCreation
      ? "Andreani rechazó la orden después de haberla creado. Requiere revisión manual."
      : result.statusChanged
        ? `Actualizado a "${result.newEstado}" según Andreani (${snapshot.logisticsEstado}).`
        : snapshot.latestEvent
          ? `${snapshot.logisticsEstado} (${snapshot.latestEvent.Fecha})`
          : `El envío continúa: ${snapshot.logisticsEstado}.`

    return NextResponse.json({
      ok: true,
      message,
      eventos: snapshot.eventos,
      checkedAt: result.checkedAt,
      statusChanged: result.statusChanged,
      newEstado: result.newEstado,
    })
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    console.error("ANDREANI_TRACKING_ERROR", {
      orderId,
      environment,
      code: safeError.code,
      status: safeError.status,
      requestId: safeError.requestId,
    })

    const status = error instanceof AndreaniError ? statusForAndreaniError(error) : 502
    return NextResponse.json(
      {
        ok: false,
        error: safeError.message,
        code: safeError.code,
        upstreamStatus: safeError.status,
        requestId: safeError.requestId,
      },
      { status },
    )
  }
}
