import { NextResponse } from "next/server"

import { AndreaniError, getEtiquetas, normalizeAndreaniError } from "@/lib/andreani/client"
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

  let body: { pedidoId?: unknown; formato?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Solicitud inválida." }, { status: 400 })
  }

  const orderId = Number(body.pedidoId)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ ok: false, error: "Pedido inválido." }, { status: 400 })
  }
  const formato = body.formato === "zpl" ? "zpl" : "pdf"

  const { data: order, error: orderError } = await authorization.admin
    .from("ordenes")
    .select("andreani_envio_id, andreani_creation_environment")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ ok: false, error: "No encontramos el pedido." }, { status: 404 })
  }

  const envioId = typeof order.andreani_envio_id === "string" ? order.andreani_envio_id.trim() : ""
  if (!envioId) {
    return NextResponse.json(
      { ok: false, error: "El pedido todavía no tiene un envío Andreani generado." },
      { status: 409 },
    )
  }

  // La etiqueta se pide contra el mismo ambiente donde se creó el envío
  // (persistido al crear), nunca contra el ambiente configurado hoy.
  const environment = order.andreani_creation_environment === "PROD" ? "PROD" : "QA"

  try {
    const label = await getEtiquetas(envioId, formato, {
      env: { ...process.env, ANDREANI_ENV: environment },
      productionAccess: environment === "PROD" ? "shipment-read" : undefined,
    })

    return new NextResponse(Buffer.from(label.data), {
      headers: {
        "Content-Type": label.contentType,
        "Content-Disposition": `inline; filename="andreani-${envioId}.${formato}"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    console.error("ANDREANI_ETIQUETA_ERROR", {
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
