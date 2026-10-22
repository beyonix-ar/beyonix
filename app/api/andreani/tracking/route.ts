import { NextResponse } from "next/server"

import { AndreaniError, normalizeAndreaniError } from "@/lib/andreani/client"
import {
  ANDREANI_ORDER_TRACKING_SELECT,
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

export async function POST(request: Request) {
  const authorization = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in authorization) return authorization.error

  let body: { pedidoId?: unknown }
  try {
    body = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_BODY")
  } catch {
    return NextResponse.json({ ok: false, error: "Solicitud inválida." }, { status: 400 })
  }

  const orderId = Number(body.pedidoId)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ ok: false, error: "Pedido inválido." }, { status: 400 })
  }

  const { data: order, error: orderError } = await authorization.admin
    .from("ordenes")
    .select(ANDREANI_ORDER_TRACKING_SELECT)
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
    const baseMessage = snapshot.rejectedAfterCreation
      ? "Andreani rechazó la orden después de haberla creado. Requiere revisión manual."
      : result.statusChanged
        ? `Actualizado a "${result.newEstado}" según Andreani (${snapshot.logisticsEstado}).`
        : snapshot.latestEvent
          ? `${snapshot.logisticsEstado} (${snapshot.latestEvent.Fecha})`
          : `El envío continúa: ${snapshot.logisticsEstado}.`
    const message = snapshot.eventosNoReconocidos.length
      ? `${baseMessage} Andreani informó un evento que BEYONIX no reconoce: quedó registrado para revisión y no cambió el estado.`
      : baseMessage

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
