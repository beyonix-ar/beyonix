import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { dispatchError, getBatchDispatch, isRequestKey, orderCode, parseOrderCode, validId } from "@/lib/admin/dispatch"

type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Lote inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  try {
    const detail = await getBatchDispatch(auth.admin, id)
    return detail ? Response.json(detail, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Lote no encontrado." }, { status: 404 })
  } catch {
    return Response.json({ error: "No se pudo cargar el lote." }, { status: 500 })
  }
}

type ParcelScan = { orderId: number; parcelIndex: number; parcelCount: number; scannedCount: number; complete: boolean; duplicate: boolean; barcode: string }

export async function POST(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Lote inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as { action?: string; orderCode?: string; orderId?: number; reason?: string; code?: string; requestKey?: string } | null
  if (!body || !["add", "remove", "close", "handover", "scan"].includes(body.action ?? "")) return Response.json({ error: "Acción inválida." }, { status: 400 })
  const orderId = body.orderCode ? parseOrderCode(body.orderCode) : Number.isSafeInteger(body.orderId) && Number(body.orderId) > 0 ? body.orderId : null
  let result: { data?: unknown; error: { message: string; details?: string | null } | null }
  let scan: ParcelScan | null = null
  if (body.action === "add") {
    if (!orderId) return Response.json({ error: "Ingresá un pedido BX válido." }, { status: 400 })
    result = await auth.admin.rpc("add_order_to_dispatch_batch", { p_batch_id: id, p_order_id: orderId, p_actor_id: auth.user.id })
  } else if (body.action === "scan") {
    const code = body.code?.trim() ?? ""
    if (!code || code.length > 64 || !isRequestKey(body.requestKey)) return Response.json({ error: "Escaneo inválido." }, { status: 400 })
    result = await auth.admin.rpc("scan_dispatch_parcel", { p_batch_id: id, p_code: code, p_actor_id: auth.user.id, p_request_key: body.requestKey })
    if (!result.error) scan = result.data as ParcelScan
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
    if (result.error.message.includes("DISPATCH_ORDER_BLOCKED") && !result.error.details) {
      const detail = await getBatchDispatch(auth.admin, id).catch(() => null)
      const blocked = detail?.items.find((item) => item.blocked)
      if (blocked) message = `${orderCode(blocked.order_id)} requiere revisión antes del despacho.`
    }
    return Response.json({ error: message }, { status: 409 })
  }
  return Response.json({ ...(await getBatchDispatch(auth.admin, id)), scan }, { headers: { "Cache-Control": "no-store" } })
}
