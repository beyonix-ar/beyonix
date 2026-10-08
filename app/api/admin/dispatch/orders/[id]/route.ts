import { after } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { quoteOrderParcels } from "@/lib/andreani/parcel-quote"
import { dispatchError, getOrderDispatch, isRequestKey, validId } from "@/lib/admin/dispatch"
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

type ScanResult = { orderItemId: number; scanned: number; expected: number; status: string; duplicate: boolean }

export async function POST(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as { action?: string; code?: string; requestKey?: string; reason?: string; parcels?: unknown } | null
  if (!body || !["start", "scan", "reset", "parcels"].includes(body.action ?? "")) return Response.json({ error: "Acción inválida." }, { status: 400 })
  let scan: ScanResult | null = null
  if (body.action === "start") {
    const result = await auth.admin.rpc("begin_order_preparation", { p_order_id: id, p_actor_id: auth.user.id })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
  } else if (body.action === "scan") {
    const code = body.code?.trim() ?? ""
    if (!code || code.length > 128 || !isRequestKey(body.requestKey)) return Response.json({ error: "Escaneo inválido." }, { status: 400 })
    // La línea se resuelve en la base, bajo el lock del armado: un reintento
    // con la misma clave devuelve el mismo resultado sin sumar otra unidad.
    const result = await auth.admin.rpc("scan_order_preparation_code", { p_order_id: id, p_code: code, p_actor_id: auth.user.id, p_request_key: body.requestKey })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
    scan = result.data as ScanResult
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
