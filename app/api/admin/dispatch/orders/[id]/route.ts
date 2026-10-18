import { after } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { AndreaniError, normalizeAndreaniError } from "@/lib/andreani/client"
import { createDispatchAndreaniShipment } from "@/lib/andreani/dispatch-shipment"
import { quoteOrderParcels } from "@/lib/andreani/parcel-quote"
import { DISPATCH_ADJUSTMENT_PROBLEMS, DISPATCH_ADJUSTMENT_SETTLEMENTS, dispatchError, getOrderDispatch, isRequestKey, validId, type DispatchScanResult } from "@/lib/admin/dispatch"
import { parseParcelMeasures, ParcelMeasuresError } from "@/lib/shipping/parcel-measures"

type Context = { params: Promise<{ id: string }> }
type Body = {
  action?: string; code?: string; requestKey?: string; reason?: string; parcels?: unknown; variantId?: unknown
  orderItemId?: unknown; quantity?: unknown; problem?: string; settlement?: string; agreement?: string; force?: boolean
}

// Los importes (cotización, diferencias) son datos financieros: el operador
// arma y resuelve diferencias, pero sólo Admin ve importes y genera envíos.
const canSeeCosts = (role: string | null | undefined) => role === "admin" || role === "super_admin"

/** Qué puede hacer quien mira el pedido. Toda regla se vuelve a validar al ejecutar. */
function viewerFor(role: string | null | undefined) {
  return { costsVisible: canSeeCosts(role), canShip: canSeeCosts(role), canForce: role === "super_admin" }
}

async function detailResponse(auth: Exclude<Awaited<ReturnType<typeof requireOperator>>, { error: Response }>, id: number, extra: Record<string, unknown> = {}) {
  const detail = await getOrderDispatch(auth.admin, id, { includeCosts: canSeeCosts(auth.profile.rol) })
  return detail
    ? Response.json({ ...detail, viewer: viewerFor(auth.profile.rol), ...extra }, { headers: { "Cache-Control": "no-store" } })
    : Response.json({ error: "Pedido no encontrado." }, { status: 404 })
}

export async function GET(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  try {
    return await detailResponse(auth, id)
  } catch {
    return Response.json({ error: "No se pudo cargar el pedido." }, { status: 500 })
  }
}

export async function POST(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as Body | null
  if (!body || !["start", "scan", "reset", "adjust", "ship"].includes(body.action ?? "")) return Response.json({ error: "Acción inválida." }, { status: 400 })
  const { data: order, error: orderError } = await auth.admin.from("ordenes")
    .select("estado,cancelled_at,financial_status,andreani_envio_id").eq("id", id).maybeSingle()
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
    if (/^BX-PREP-/i.test(code)) return Response.json({ error: "Ese es el código de un pedido, no de un producto." }, { status: 409 })
    // La línea se resuelve en la base, bajo el lock del armado: un reintento
    // con la misma clave devuelve el mismo resultado sin sumar otra unidad.
    const result = await auth.admin.rpc("scan_order_preparation_code", { p_order_id: id, p_code: code, p_actor_id: auth.user.id, p_request_key: body.requestKey, p_variant_id: variantId })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
    scan = result.data as DispatchScanResult
  } else if (body.action === "adjust") {
    // Diferencia de pickeo: la cantidad, el importe y la auditoría los resuelve
    // la base. El dinero nunca se mueve acá: queda pendiente de gestión manual.
    const orderItemId = Number(body.orderItemId)
    const quantity = Number(body.quantity)
    const agreement = body.agreement?.trim() ?? ""
    if (!Number.isSafeInteger(orderItemId) || orderItemId <= 0 || !Number.isSafeInteger(quantity) || quantity < 0
      || !(body.problem && body.problem in DISPATCH_ADJUSTMENT_PROBLEMS) || !(body.settlement && body.settlement in DISPATCH_ADJUSTMENT_SETTLEMENTS)
      || agreement.length < 10 || agreement.length > 1000 || !isRequestKey(body.requestKey)) {
      return Response.json({ error: "Completá el problema, la cantidad que sale y el acuerdo con el cliente (mínimo 10 caracteres)." }, { status: 400 })
    }
    const result = await auth.admin.rpc("adjust_order_preparation_line", { p_order_id: id, p_order_item_id: orderItemId, p_quantity: quantity, p_problem: body.problem, p_settlement: body.settlement, p_agreement: agreement, p_actor_id: auth.user.id, p_request_key: body.requestKey })
    if (result.error) return Response.json({ error: dispatchError(result.error) }, { status: 409 })
  } else if (body.action === "ship") {
    const role = auth.profile.rol
    if (!canSeeCosts(role)) return Response.json({ error: "El envío Andreani lo genera un Admin." }, { status: 403 })
    const force = body.force === true
    const reason = body.reason?.trim() ?? ""
    if (force && role !== "super_admin") return Response.json({ error: "Sólo Super Admin puede generar el envío con el pickeo incompleto." }, { status: 403 })
    if (force && (reason.length < 10 || reason.length > 1000)) return Response.json({ error: "Ingresá el motivo de la excepción (mínimo 10 caracteres)." }, { status: 400 })
    if (!isRequestKey(body.requestKey)) return Response.json({ error: "Solicitud inválida." }, { status: 400 })
    // Medidas reales de cada bulto (lo que Andreani cobra): sólo antes de crear el envío.
    if (body.parcels !== undefined && !order.andreani_envio_id) {
      let parcels: ReturnType<typeof parseParcelMeasures>
      try {
        parcels = parseParcelMeasures(body.parcels)
      } catch (error) {
        return Response.json({ error: error instanceof ParcelMeasuresError ? error.message : "Medidas inválidas." }, { status: 400 })
      }
      const measured = await auth.admin.rpc("set_order_package_parcels_measured", { p_order_id: id, p_parcels: parcels, p_actor_id: auth.user.id, p_request_key: body.requestKey })
      if (measured.error) return Response.json({ error: dispatchError(measured.error) }, { status: 409 })
    }
    if (force) {
      const audit = await auth.admin.from("order_audit_events").insert({ order_id: id, actor_type: "admin", actor_id: auth.user.id, action: "andreani_shipment_forced_incomplete_preparation", metadata: { reason, requestKey: body.requestKey } })
      if (audit.error) return Response.json({ error: "No se pudo registrar la excepción." }, { status: 500 })
    }
    try {
      await createDispatchAndreaniShipment(auth.admin, id, { allowIncompletePreparation: force })
    } catch (error) {
      const safeError = normalizeAndreaniError(error)
      console.error("DISPATCH_ANDREANI_SHIPMENT_ERROR", { orderId: id, code: safeError.code, status: safeError.status, requestId: safeError.requestId })
      return Response.json({ error: safeError.message }, { status: error instanceof AndreaniError && error.code === "VALIDATION_ERROR" ? 409 : 502 })
    }
    if (!order.andreani_envio_id) {
      const audit = await auth.admin.from("order_audit_events").insert({
        order_id: id, actor_type: "admin", actor_id: auth.user.id,
        action: "dispatch_andreani_shipment_generated", metadata: { requestKey: body.requestKey, forced: force },
      })
      if (audit.error && audit.error.code !== "23505") return Response.json({ error: "El envío se creó, pero no se pudo registrar el operador. Reintentá para verificarlo." }, { status: 500 })
    }
    // Recotización con los bultos reales, después de responder. Nunca cobra al cliente.
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
    return await detailResponse(auth, id, { scan })
  } catch {
    return Response.json({ error: "La operación se guardó, pero no se pudo actualizar la vista. Recargá el pedido." }, { status: 503 })
  }
}
