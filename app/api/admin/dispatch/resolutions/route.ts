import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { dispatchError, isRequestKey, type CancellationResolutionResult } from "@/lib/admin/dispatch"

// Retiro físico de un pedido cancelado después del armado: el escaneo del
// código del pedido preparado (o de un bulto) confirma que la mercadería volvió.
// Toda la validación, el retiro del lote y la devolución de stock son una sola
// transacción idempotente en la base (resolve_cancelled_order_preparation).
export async function POST(request: Request) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as { code?: unknown; requestKey?: unknown; orderId?: unknown } | null
  const code = typeof body?.code === "string" ? body.code.trim() : ""
  const orderId = body?.orderId == null ? null : Number(body.orderId)
  if (!code || code.length > 64 || !isRequestKey(body?.requestKey) || (orderId !== null && (!Number.isSafeInteger(orderId) || orderId <= 0))) {
    return Response.json({ error: "Escaneo inválido." }, { status: 400 })
  }
  const { data, error } = await auth.admin.rpc("resolve_cancelled_order_preparation", {
    p_code: code, p_actor_id: auth.user.id, p_request_key: body?.requestKey, p_expected_order_id: orderId,
  })
  if (error) return Response.json({ error: dispatchError(error) }, { status: 409 })
  const result = data as CancellationResolutionResult
  return Response.json({ orderId: result.orderId, units: result.units, pickedUnits: result.pickedUnits, batchId: result.batchId, batchCode: result.batchCode ?? null, duplicate: result.duplicate, alreadyResolved: result.alreadyResolved } satisfies CancellationResolutionResult, { headers: { "Cache-Control": "no-store" } })
}
