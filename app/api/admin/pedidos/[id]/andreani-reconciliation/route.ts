import { NextResponse } from "next/server"

import { requireInternalUser } from "@/lib/auth/admin-api"

const VALID_RESOLUTIONS = ["created", "not_created"] as const
type Resolution = (typeof VALID_RESOLUTIONS)[number]

/**
 * BLOQUEANTE 2 (auditoría Andreani Parte 3/4): único endpoint que puede
 * sacar un pedido de andreani_creation_status='reconciliation_required' (o
 * de un 'claimed' vencido de ese mismo pedido). Nunca reintenta el POST a
 * Andreani -- exige que un admin/super_admin confirme explícitamente, por
 * fuera del sistema, si el envío existe o no. Toda la atomicidad/CAS/
 * auditoría vive en public.resolve_andreani_reconciliation (RPC,
 * 20260917100000_andreani_manual_reconciliation.sql).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  let body: {
    resolution?: unknown
    envioId?: unknown
    tracking?: unknown
    etiquetaUrl?: unknown
    notes?: unknown
  }
  try {
    body = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("INVALID_BODY")
    }
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 })
  }

  const resolution = typeof body.resolution === "string" ? body.resolution : ""
  if (!VALID_RESOLUTIONS.includes(resolution as Resolution)) {
    return NextResponse.json(
      { error: "Elegí si el envío existe o no." },
      { status: 400 },
    )
  }

  const notes = typeof body.notes === "string" ? body.notes.trim() : ""
  if (notes.length < 5 || notes.length > 1000) {
    return NextResponse.json(
      { error: "Contanos con al menos 5 caracteres cómo confirmaste esto con Andreani." },
      { status: 400 },
    )
  }

  const envioId = typeof body.envioId === "string" ? body.envioId.trim() : ""
  const tracking = typeof body.tracking === "string" ? body.tracking.trim() : ""
  const etiquetaUrl = typeof body.etiquetaUrl === "string" ? body.etiquetaUrl.trim() : ""

  if (resolution === "created" && !envioId) {
    return NextResponse.json(
      { error: "Ingresá el número de envío Andreani real." },
      { status: 400 },
    )
  }

  const { data: order, error: rpcError } = await auth.admin.rpc(
    "resolve_andreani_reconciliation",
    {
      p_order_id: orderId,
      p_admin_id: auth.user.id,
      p_admin_role: auth.profile.rol,
      p_resolution: resolution,
      p_envio_id: resolution === "created" ? envioId : null,
      p_tracking: resolution === "created" ? tracking || null : null,
      p_etiqueta_url: resolution === "created" ? etiquetaUrl || null : null,
      p_notes: notes,
    },
  )

  if (rpcError || !order) {
    const message = rpcError?.message ?? ""

    if (message.includes("ORDER_NOT_FOUND")) {
      return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
    }
    if (message.includes("ANDREANI_RECONCILIATION_FORBIDDEN")) {
      return NextResponse.json(
        { error: "Sólo un administrador puede conciliar este pedido." },
        { status: 403 },
      )
    }
    if (message.includes("ANDREANI_RECONCILIATION_NOT_PENDING")) {
      return NextResponse.json(
        {
          error:
            "Este pedido ya no tiene un resultado Andreani pendiente de conciliar. Actualizá la página.",
        },
        { status: 409 },
      )
    }
    if (message.includes("ANDREANI_SHIPMENT_ALREADY_PERSISTED")) {
      return NextResponse.json(
        { error: "Este pedido ya tiene un envío Andreani persistido. Actualizá la página." },
        { status: 409 },
      )
    }
    if (message.includes("ANDREANI_RECONCILIATION_CONFLICT")) {
      return NextResponse.json(
        {
          error:
            "Otra persona ya conciliaba este pedido al mismo tiempo. Actualizá la página y revisá el resultado.",
        },
        { status: 409 },
      )
    }
    if (message.includes("ANDREANI_RECONCILIATION_INVALID_ENVIO_ID")) {
      return NextResponse.json(
        { error: "El número de envío ingresado no es válido." },
        { status: 400 },
      )
    }
    if (message.includes("ANDREANI_RECONCILIATION_INVALID_TRACKING")) {
      return NextResponse.json(
        { error: "El número de tracking ingresado no es válido." },
        { status: 400 },
      )
    }
    if (message.includes("ANDREANI_RECONCILIATION_INVALID_LABEL_URL")) {
      return NextResponse.json(
        { error: "La URL de la etiqueta no es válida." },
        { status: 400 },
      )
    }
    if (message.includes("ANDREANI_RECONCILIATION_INVALID_NOTES")) {
      return NextResponse.json(
        { error: "Contanos con al menos 5 caracteres cómo confirmaste esto con Andreani." },
        { status: 400 },
      )
    }
    if (message.includes("ANDREANI_RECONCILIATION_INVALID_RESOLUTION")) {
      return NextResponse.json(
        { error: "Elegí si el envío existe o no." },
        { status: 400 },
      )
    }

    return NextResponse.json(
      { error: "No se pudo conciliar el pedido de forma segura." },
      { status: 500 },
    )
  }

  return NextResponse.json({
    order,
    message:
      resolution === "created"
        ? "Envío Andreani conciliado como creado."
        : "Pedido liberado: puede volver a intentarse la creación del envío.",
  })
}
