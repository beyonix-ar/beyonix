import { requireInternalUser } from "@/lib/auth/admin-api"

const EVENT_TYPES = new Set(["payment_proof", "order_summary"])

function parseOrderIds(value: string | null) {
  if (!value) return []
  const ids = value
    .split(",")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0)
  return [...new Set(ids)].slice(0, 500)
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const url = new URL(request.url)
  const eventType = url.searchParams.get("eventType") ?? ""
  const orderIds = parseOrderIds(url.searchParams.get("orderIds"))

  if (!EVENT_TYPES.has(eventType) || orderIds.length === 0) {
    return Response.json({ error: "Consulta inválida." }, { status: 400 })
  }

  const { data, error } = await auth.admin
    .from("admin_order_event_views")
    .select("order_id, event_at")
    .eq("admin_id", auth.user.id)
    .eq("event_type", eventType)
    .in("order_id", orderIds)

  if (error) {
    return Response.json(
      { error: "No se pudieron consultar los eventos vistos." },
      { status: 500 },
    )
  }

  return Response.json({ views: data ?? [] }, {
    headers: { "Cache-Control": "private, no-store" },
  })
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as
    | { orderId?: unknown; eventType?: unknown; eventAt?: unknown }
    | null
  const orderId = Number(body?.orderId)
  const eventType = typeof body?.eventType === "string" ? body.eventType : ""
  const eventAt = typeof body?.eventAt === "string" ? body.eventAt : ""
  const eventTime = Date.parse(eventAt)

  if (
    !Number.isSafeInteger(orderId) ||
    orderId <= 0 ||
    !EVENT_TYPES.has(eventType) ||
    !Number.isFinite(eventTime)
  ) {
    return Response.json({ error: "Evento inválido." }, { status: 400 })
  }

  const now = new Date().toISOString()
  const { error } = await auth.admin.from("admin_order_event_views").upsert(
    {
      admin_id: auth.user.id,
      order_id: orderId,
      event_type: eventType,
      event_at: new Date(eventTime).toISOString(),
      seen_at: now,
      updated_at: now,
    },
    { onConflict: "admin_id,order_id,event_type" },
  )

  if (error) {
    return Response.json(
      { error: "No se pudo registrar el evento visto." },
      { status: 500 },
    )
  }

  return Response.json({ ok: true }, {
    headers: { "Cache-Control": "private, no-store" },
  })
}
