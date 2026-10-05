import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { dispatchError, getBatchDispatch, parseOrderCode, validId } from "@/lib/admin/dispatch"

type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Tanda inválida." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  try {
    const detail = await getBatchDispatch(auth.admin, id)
    return detail ? Response.json(detail, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Tanda no encontrada." }, { status: 404 })
  } catch {
    return Response.json({ error: "No se pudo cargar la tanda." }, { status: 500 })
  }
}

export async function POST(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Tanda inválida." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as { action?: string; orderCode?: string; orderId?: number; reason?: string } | null
  if (!body || !["add", "remove", "close", "handover"].includes(body.action ?? "")) return Response.json({ error: "Acción inválida." }, { status: 400 })
  const orderId = body.orderCode ? parseOrderCode(body.orderCode) : Number.isSafeInteger(body.orderId) && Number(body.orderId) > 0 ? body.orderId : null
  let result: { error: { message: string } | null }
  if (body.action === "add") {
    if (!orderId) return Response.json({ error: "Ingresá un pedido BX válido." }, { status: 400 })
    result = await auth.admin.rpc("add_order_to_dispatch_batch", { p_batch_id: id, p_order_id: orderId, p_actor_id: auth.user.id })
  } else if (body.action === "remove") {
    const reason = body.reason?.trim() ?? ""
    if (!orderId || reason.length < 10 || reason.length > 1000) return Response.json({ error: "Ingresá un motivo de al menos 10 caracteres." }, { status: 400 })
    result = await auth.admin.rpc("remove_order_from_dispatch_batch", { p_batch_id: id, p_order_id: orderId, p_actor_id: auth.user.id, p_reason: reason })
  } else if (body.action === "close") {
    result = await auth.admin.rpc("close_dispatch_batch", { p_batch_id: id, p_actor_id: auth.user.id })
  } else {
    result = await auth.admin.rpc("hand_over_dispatch_batch", { p_batch_id: id, p_actor_id: auth.user.id })
  }
  if (result.error) {
    let message = dispatchError(result.error)
    if (result.error.message.includes("DISPATCH_ORDER_BLOCKED")) {
      const detail = await getBatchDispatch(auth.admin, id).catch(() => null)
      const blocked = detail?.items.find((item) => item.blocked)
      if (blocked) message = `${String(1000 + blocked.order_id).padStart(4, "0").replace(/^/, "BX-")} requiere revisión antes del despacho.`
    }
    return Response.json({ error: message }, { status: 409 })
  }
  return Response.json(await getBatchDispatch(auth.admin, id), { headers: { "Cache-Control": "no-store" } })
}
