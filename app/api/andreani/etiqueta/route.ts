import { NextResponse } from "next/server"

import { AndreaniError, normalizeAndreaniError } from "@/lib/andreani/client"
import { fetchAndreaniOrderLabel } from "@/lib/andreani/dispatch-shipment"
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
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_BODY")
  } catch {
    return NextResponse.json({ ok: false, error: "Solicitud inválida." }, { status: 400 })
  }

  const orderId = Number(body.pedidoId)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ ok: false, error: "Pedido inválido." }, { status: 400 })
  }
  const formato = body.formato === "zpl" ? "zpl" : "pdf"

  try {
    // La etiqueta se pide contra el mismo ambiente donde se creó el envío.
    const label = await fetchAndreaniOrderLabel(authorization.admin, orderId, formato)

    return new NextResponse(Buffer.from(label.data), {
      headers: {
        "Content-Type": label.contentType,
        "Content-Disposition": `inline; filename="andreani-${label.envioId}.${formato}"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    console.error("ANDREANI_ETIQUETA_ERROR", {
      orderId,
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
