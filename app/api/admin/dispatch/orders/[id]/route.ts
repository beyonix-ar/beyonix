import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { dispatchError, getOrderDispatch, resolveScanLine, validId } from "@/lib/admin/dispatch"

type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  try {
    const detail = await getOrderDispatch(auth.admin, id)
    return detail ? Response.json(detail, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Pedido no encontrado." }, { status: 404 })
  } catch {
    return Response.json({ error: "No se pudo cargar el pedido." }, { status: 500 })
  }
}

export async function POST(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as { action?: string; code?: string; requestKey?: string; reason?: string } | null
  if (!body || !["start", "scan", "reset"].includes(body.action ?? "")) return Response.json({ error: "Acción inválida." }, { status: 400 })
  if (body.action === "start") {
    const result = await auth.admin.rpc("begin_order_preparation", { p_order_id: id, p_actor_id: auth.user.id })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
  } else if (body.action === "scan") {
    const code = body.code?.trim() ?? ""
    if (!code || code.length > 128 || !body.requestKey || !/^[0-9a-f-]{36}$/i.test(body.requestKey)) return Response.json({ error: "Escaneo inválido." }, { status: 400 })
    const detail = await getOrderDispatch(auth.admin, id).catch(() => null)
    if (!detail?.package) return Response.json({ error: "Iniciá la preparación primero." }, { status: 409 })
    // En un reintento se conserva el artículo original aunque haya otra línea con el mismo SKU.
    const prior = await auth.admin.from("order_preparation_scans").select("order_item_id,code").eq("package_id", detail.package.id).eq("attempt_number", detail.package.attempt_number).eq("request_key", body.requestKey).maybeSingle()
    if (prior.error) return Response.json({ error: "No se pudo validar el escaneo." }, { status: 500 })
    if (prior.data && prior.data.code !== code) return Response.json({ error: "Este escaneo ya fue utilizado con otro código." }, { status: 409 })
    const priorScan = prior.data
    const line = priorScan ? detail.lines.find((item) => item.order_item_id === priorScan.order_item_id) : resolveScanLine(detail.lines, code)
    if (!line) return Response.json({ error: "Este producto no pertenece al pedido." }, { status: 409 })
    const result = await auth.admin.rpc("scan_order_preparation_item", { p_order_id: id, p_order_item_id: line.order_item_id, p_code: code, p_actor_id: auth.user.id, p_request_key: body.requestKey })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
  } else {
    const reason = body.reason?.trim() ?? ""
    if (reason.length < 10 || reason.length > 1000 || !body.requestKey || !/^[0-9a-f-]{36}$/i.test(body.requestKey)) return Response.json({ error: "Ingresá un motivo de al menos 10 caracteres." }, { status: 400 })
    const result = await auth.admin.rpc("reset_order_preparation", { p_order_id: id, p_actor_id: auth.user.id, p_request_key: body.requestKey, p_reason: reason })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
  }
  try {
    return Response.json(await getOrderDispatch(auth.admin, id), { headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json({ error: "La operación se guardó, pero no se pudo actualizar la vista. Recargá el pedido." }, { status: 503 })
  }
}
