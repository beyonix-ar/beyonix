import { NextResponse } from "next/server"

import {
  AndreaniError,
  getEstadoOrden,
  getTrackingPullV3,
  normalizeAndreaniError,
} from "@/lib/andreani/client"
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

  const { data: order, error: orderError } = await authorization.admin
    .from("ordenes")
    .select("andreani_tracking, andreani_envio_id, andreani_creation_environment")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ ok: false, error: "No encontramos el pedido." }, { status: 404 })
  }

  const envioId =
    typeof order.andreani_envio_id === "string" ? order.andreani_envio_id.trim() : ""
  const numeroDeTracking =
    typeof order.andreani_tracking === "string" ? order.andreani_tracking.trim() : ""
  if (!envioId) {
    return NextResponse.json(
      { ok: false, error: "El pedido todavía no tiene un envío Andreani generado." },
      { status: 409 },
    )
  }

  // El tracking se consulta contra el mismo ambiente donde se creó el
  // envío (persistido al crear), nunca contra el ambiente configurado hoy.
  const environment = order.andreani_creation_environment === "PROD" ? "PROD" : "QA"

  try {
    const clientOptions = {
      env: { ...process.env, ANDREANI_ENV: environment },
      productionAccess: environment === "PROD" ? "shipment-read" as const : undefined,
    }
    // Se consulta siempre, incluso con tracking ya conocido: es la única
    // forma de detectar que Andreani rechazó la orden después de haberla
    // creado (estado "Rechazado"), algo que /v3/trazas no informa.
    const orderStatus = await getEstadoOrden(envioId, clientOptions)
    const resolvedTracking =
      numeroDeTracking || orderStatus.bultos[0]?.numeroDeEnvio || ""
    const tracking = resolvedTracking
      ? await getTrackingPullV3(resolvedTracking, clientOptions)
      : { eventos: [] }

    const sortedEvents = [...tracking.eventos].sort(
      (left, right) => new Date(right.Fecha).getTime() - new Date(left.Fecha).getTime(),
    )
    const [latestEvent] = sortedEvents
    // Algunos eventos (p. ej. "OrdenDeEnvioCreada") no traen un Estado
    // legible en /v3/trazas -- el estado logístico mostrado al admin debe
    // reflejar el evento más reciente que sí lo tenga, no el técnicamente
    // más reciente sin más (si no, se pisa un estado real como "Pendiente
    // de ingreso" con un código interno como "OrdenDeEnvioCreada").
    const latestEventWithEstado = sortedEvents.find((event) => event.Estado)
    const rejectedAfterCreation = orderStatus.estado === "Rechazado"
    const logisticsEstado = rejectedAfterCreation
      ? orderStatus.estado
      : (latestEventWithEstado?.Estado ?? orderStatus.estado)

    const checkedAt = new Date().toISOString()
    const updatePayload = {
      andreani_estado: logisticsEstado,
      andreani_tracking: resolvedTracking || null,
      andreani_etiqueta_url:
        orderStatus.etiquetasPorAgrupador ??
        orderStatus.bultos[0]?.linking?.find((link) =>
          link.meta.toLowerCase().includes("etiqueta"),
        )?.contenido ??
        null,
      ...(latestEvent ? { andreani_tracking_event_at: latestEvent.Fecha } : {}),
      andreani_tracking_checked_at: checkedAt,
    }
    const { error: persistenceError } = await authorization.admin
      .from("ordenes")
      .update(updatePayload as never)
      .eq("id", orderId)

    if (persistenceError) {
      throw new AndreaniError(
        "REQUEST_FAILED",
        "Andreani respondió, pero no se pudo persistir el estado del envío.",
      )
    }

    const message = rejectedAfterCreation
      ? "Andreani rechazó la orden después de haberla creado. Requiere revisión manual."
      : latestEvent
        ? `${logisticsEstado} (${latestEvent.Fecha})`
        : `El envío continúa: ${logisticsEstado}.`

    return NextResponse.json({
      ok: true,
      message,
      eventos: tracking.eventos,
      checkedAt,
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
