import { after } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { quoteOrderParcels } from "@/lib/andreani/parcel-quote"
import { dispatchError, getOrderDispatch, isRequestKey, validId, type DispatchScanResult } from "@/lib/admin/dispatch"
import { parseParcelMeasures, ParcelMeasuresError } from "@/lib/shipping/parcel-measures"

type Context = { params: Promise<{ id: string }> }

// Los costos de envío (cotización y recotización) son datos financieros:
// el operador arma y carga medidas, pero sólo Admin ve importes.
const canSeeCosts = (role: string | null | undefined) => role === "admin" || role === "super_admin"

export async function GET(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  try {
    const detail = await getOrderDispatch(auth.admin, id, { includeCosts: canSeeCosts(auth.profile.rol) })
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
  const body = await request.json().catch(() => null) as { action?: string; code?: string; requestKey?: string; reason?: string; parcels?: unknown; variantId?: unknown; method?: string } | null
  if (!body || !["start", "scan", "reset", "parcels", "identify"].includes(body.action ?? "")) return Response.json({ error: "Acción inválida." }, { status: 400 })
  const { data: order, error: orderError } = await auth.admin.from("ordenes")
    .select("estado,cancelled_at,financial_status").eq("id", id).maybeSingle()
  if (orderError || !order) return Response.json({ error: "No se pudo verificar el pedido." }, { status: 500 })
  if (order.estado === "cancelado" || order.cancelled_at || ["cancellation_requested", "refund_pending", "refunded"].includes(order.financial_status ?? "")) {
    return Response.json({ error: "Pedido cancelado — no requiere preparación." }, { status: 409 })
  }
  let scan: DispatchScanResult | null = null
  if (body.action === "start") {
    const result = await auth.admin.rpc("begin_order_preparation", { p_order_id: id, p_actor_id: auth.user.id })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
  } else if (body.action === "scan") {
    const code = body.code?.trim() ?? ""
    // variantId: confirmación explícita de la variante física después de un
    // código de grupo en un renglón aleatorio (la base valida que corresponda).
    const variantId = body.variantId == null ? null : Number(body.variantId)
    if (!code || code.length > 128 || !isRequestKey(body.requestKey) || (variantId !== null && (!Number.isSafeInteger(variantId) || variantId <= 0))) return Response.json({ error: "Escaneo inválido." }, { status: 400 })
    if (/^BX-PREP-/i.test(code)) return Response.json({ error: "Ese es el código de un pedido preparado, no de un producto." }, { status: 409 })
    // La línea se resuelve en la base, bajo el lock del armado: un reintento
    // con la misma clave devuelve el mismo resultado sin sumar otra unidad.
    const result = await auth.admin.rpc("scan_order_preparation_code", { p_order_id: id, p_code: code, p_actor_id: auth.user.id, p_request_key: body.requestKey, p_variant_id: variantId })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
    scan = result.data as DispatchScanResult
  } else if (body.action === "identify") {
    // Identificación física del pedido preparado: etiqueta BX-PREP colocada o
    // código escrito a mano. La base valida que sea el BX-PREP vigente.
    const code = body.code?.trim() ?? ""
    if ((body.method !== "printed" && body.method !== "manual") || !code || code.length > 64 || !isRequestKey(body.requestKey)) return Response.json({ error: "Identificación inválida." }, { status: 400 })
    const result = await auth.admin.rpc("confirm_order_physical_identification", { p_order_id: id, p_code: code, p_method: body.method, p_actor_id: auth.user.id, p_request_key: body.requestKey })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
  } else if (body.action === "parcels") {
    if (!isRequestKey(body.requestKey)) return Response.json({ error: "Solicitud inválida." }, { status: 400 })
    let parcels: ReturnType<typeof parseParcelMeasures>
    try {
      parcels = parseParcelMeasures(body.parcels)
    } catch (error) {
      return Response.json({ error: error instanceof ParcelMeasuresError ? error.message : "Medidas inválidas." }, { status: 400 })
    }
    const result = await auth.admin.rpc("set_order_package_parcels_measured", { p_order_id: id, p_parcels: parcels, p_actor_id: auth.user.id, p_request_key: body.requestKey })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
    // Recotización con los bultos reales, después de responder: no demora
    // el armado. Nunca cobra al cliente; sólo deja la comparación guardada.
    after(async () => {
      const outcome = await quoteOrderParcels(auth.admin, id).catch(() => ({ status: "failed" as const, error: "UNEXPECTED_ERROR" }))
      if (outcome.status === "failed") console.warn("ORDER_PARCEL_QUOTE_FAILED", { orderId: id, code: outcome.error })
    })
  } else {
    const reason = body.reason?.trim() ?? ""
    if (reason.length < 10 || reason.length > 1000 || !isRequestKey(body.requestKey)) return Response.json({ error: "Ingresá un motivo de al menos 10 caracteres." }, { status: 400 })
    const result = await auth.admin.rpc("reset_order_preparation", { p_order_id: id, p_actor_id: auth.user.id, p_request_key: body.requestKey, p_reason: reason })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
  }
  try {
    const detail = await getOrderDispatch(auth.admin, id, { includeCosts: canSeeCosts(auth.profile.rol) })
    return Response.json({ ...detail, scan }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json({ error: "La operación se guardó, pero no se pudo actualizar la vista. Recargá el pedido." }, { status: 503 })
  }
}
