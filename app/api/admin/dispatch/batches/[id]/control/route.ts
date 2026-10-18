import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { dispatchError, dispatchHold, getBatchDispatch, HOLD_COLUMNS, validId } from "@/lib/admin/dispatch"

type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Bulto inválido." }, { status: 400 })
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  try {
    const detail = await getBatchDispatch(auth.admin, id)
    if (!detail) return Response.json({ error: "Bulto no encontrado." }, { status: 404 })
    const [removedResult, holdsResult, ordersResult] = await Promise.all([
      auth.admin.from("dispatch_batch_items").select("order_id,removed_at").eq("batch_id", id).not("removed_at", "is", null).order("order_id"),
      auth.admin.from("order_cancellation_holds").select(HOLD_COLUMNS).eq("batch_id", id).is("resolved_at", null),
      detail.items.length ? auth.admin.from("ordenes").select("id,estado,cancelled_at").in("id", detail.items.map((item) => item.order_id)) : Promise.resolve({ data: [], error: null }),
    ])
    if (removedResult.error || holdsResult.error || ordersResult.error) throw removedResult.error ?? holdsResult.error ?? ordersResult.error
    const cancelled = new Set((ordersResult.data ?? []).filter((order) => order.estado === "cancelado" || order.cancelled_at).map((order) => order.id))
    const holds = new Map((holdsResult.data ?? []).map((row) => [row.order_id, dispatchHold(row, detail.batch.code)]))
    return Response.json({ batch: detail.batch, name: detail.batch.display_number ?? detail.batch.id,
      items: detail.items.map((item) => ({ orderId: item.order_id, status: cancelled.has(item.order_id) || item.cancellationHold ? "CANCELADO" : "CORRECTO", blocked: item.blocked, hold: holds.get(item.order_id) ?? null })),
      removedOrderIds: (removedResult.data ?? []).map((item) => item.order_id), parcelCount: detail.parcelCount,
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch {
    return Response.json({ error: "No se pudo cargar el Bulto." }, { status: 500 })
  }
}

export async function POST(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Bulto inválido." }, { status: 400 })
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const { data, error } = await auth.admin.rpc("confirm_dispatch_batch_mobile_control", { p_batch_id: id, p_actor_id: auth.user.id })
  if (error) return Response.json({ error: dispatchError(error) }, { status: 409 })
  return Response.json(data, { headers: { "Cache-Control": "private, no-store" } })
}
