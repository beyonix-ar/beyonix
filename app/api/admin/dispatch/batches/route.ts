import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { dispatchError, getBatchDispatch, isRequestKey } from "@/lib/admin/dispatch"

// Límite técnico de payload, no de negocio: la creación es una sola
// transacción (todo o nada) en create_dispatch_batch_with_orders.
const MAX_ORDERS_PER_REQUEST = 2000

export async function POST(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as { requestKey?: string; orderIds?: unknown } | null
  if (!body || !isRequestKey(body.requestKey)) return Response.json({ error: "Solicitud inválida." }, { status: 400 })
  const orderIds = body.orderIds === undefined ? [] : Array.isArray(body.orderIds) ? body.orderIds : null
  if (!orderIds || orderIds.length > MAX_ORDERS_PER_REQUEST || !orderIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0)) {
    return Response.json({ error: "Selección de pedidos inválida." }, { status: 400 })
  }
  const result = orderIds.length
    ? await auth.admin.rpc("create_dispatch_batch_with_orders", { p_actor_id: auth.user.id, p_request_key: body.requestKey, p_order_ids: orderIds })
    : await auth.admin.rpc("create_dispatch_batch", { p_actor_id: auth.user.id, p_request_key: body.requestKey })
  if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
  return Response.json(await getBatchDispatch(auth.admin, result.data.id))
}
