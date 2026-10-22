import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { dispatchError, getBatchDispatch, isRequestKey, orderCode, parseOrderCode, validId, type DispatchVerificationResult } from "@/lib/admin/dispatch"
import { getDispatchHistory } from "@/lib/admin/dispatch-history"
import { matchesDispatchBatch } from "@/lib/admin/dispatch-scan"

type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Lote inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  try {
    if (new URL(request.url).searchParams.has("history")) {
      const history = await getDispatchHistory(auth.admin, id)
      return history ? Response.json(history, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Bulto no encontrado." }, { status: 404 })
    }
    if (new URL(request.url).searchParams.has("events")) {
      const result = await auth.admin.from("dispatch_batch_events").select("id,action,order_id,created_at,metadata").eq("batch_id", id).order("id", { ascending: false }).limit(100)
      if (result.error) throw result.error
      return Response.json(result.data ?? [], { headers: { "Cache-Control": "no-store" } })
    }
    const detail = await getBatchDispatch(auth.admin, id)
    return detail ? Response.json(detail, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Lote no encontrado." }, { status: 404 })
  } catch {
    return Response.json({ error: "No se pudo cargar el lote." }, { status: 500 })
  }
}

// Scanner, cámara y código tipeado/pegado usan la misma validación.
const VERIFY_METHODS = new Set(["scanner", "camera", "manual_code"])

export async function POST(request: Request, context: Context) {
  const id = validId((await context.params).id)
  if (!id) return Response.json({ error: "Lote inválido." }, { status: 400 })
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as { action?: string; orderCode?: string; orderId?: number; reason?: string; code?: string; requestKey?: string; method?: string } | null
  if (!body || !["add", "remove", "close", "handover", "verify", "reopen"].includes(body.action ?? "")) return Response.json({ error: "Acción inválida." }, { status: 400 })
  const orderId = body.orderCode ? parseOrderCode(body.orderCode) : Number.isSafeInteger(body.orderId) && Number(body.orderId) > 0 ? body.orderId : null
  let result: { data?: unknown; error: { message: string; details?: string | null } | null }
  let verification: DispatchVerificationResult | null = null
  let handover: { duplicate: boolean } | null = null
  if (body.action === "add") {
    if (!orderId) return Response.json({ error: "Ingresá un pedido BX válido." }, { status: 400 })
    result = await auth.admin.rpc("add_order_to_dispatch_batch", { p_batch_id: id, p_order_id: orderId, p_actor_id: auth.user.id })
  } else if (body.action === "verify") {
    // Una lectura Andreani por pedido; la última finaliza el Bulto de forma atómica.
    const method = body.method ?? ""
    const code = body.code?.trim() ?? ""
    if (!VERIFY_METHODS.has(method) || !isRequestKey(body.requestKey) || !code || code.length > 64) return Response.json({ error: "Lectura inválida." }, { status: 400 })
    result = await auth.admin.rpc("verify_and_finalize_dispatch_batch", { p_batch_id: id, p_code: code, p_method: method, p_actor_id: auth.user.id, p_request_key: body.requestKey, p_order_id: null })
    if (!result.error) verification = result.data as DispatchVerificationResult
  } else if (body.action === "remove") {
    const reason = body.reason?.trim() ?? ""
    if (!orderId || reason.length < 10 || reason.length > 1000) return Response.json({ error: "Ingresá un motivo de al menos 10 caracteres." }, { status: 400 })
    result = await auth.admin.rpc("remove_order_from_dispatch_batch", { p_batch_id: id, p_order_id: orderId, p_actor_id: auth.user.id, p_reason: reason })
  } else if (body.action === "close") {
    result = await auth.admin.rpc("close_dispatch_batch", { p_batch_id: id, p_actor_id: auth.user.id })
  } else if (body.action === "reopen") {
    if (auth.profile.rol !== "super_admin") return Response.json({ error: "Sólo Super Admin puede reabrir un Bulto." }, { status: 403 })
    const reason = body.reason?.trim() ?? ""
    if (reason.length < 10 || reason.length > 1000) return Response.json({ error: "Ingresá un motivo de al menos 10 caracteres." }, { status: 400 })
    result = await auth.admin.rpc("reopen_dispatch_batch", { p_batch_id: id, p_actor_id: auth.user.id, p_reason: reason })
  } else {
    // La entrega se confirma con la etiqueta del Bulto: QR de control, DSP o nombre impreso.
    const code = body.code?.trim() ?? ""
    if (!code || code.length > 128) return Response.json({ error: "Escaneá o ingresá el QR del Bulto para confirmar la entrega." }, { status: 400 })
    const batchResult = await auth.admin.from("dispatch_batches").select("id,code,display_number").eq("id", id).maybeSingle()
    if (batchResult.error) return Response.json({ error: "No se pudo confirmar la entrega." }, { status: 500 })
    if (!batchResult.data) return Response.json({ error: "Lote no encontrado." }, { status: 404 })
    if (!matchesDispatchBatch(code, batchResult.data)) return Response.json({ error: dispatchError({ message: "DISPATCH_HANDOVER_CODE_MISMATCH" }) }, { status: 409 })
    result = await auth.admin.rpc("confirm_dispatch_batch_handover", { p_batch_id: id, p_code: batchResult.data.code, p_actor_id: auth.user.id })
    if (!result.error) handover = result.data as { duplicate: boolean }
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
  return Response.json({ ...(await getBatchDispatch(auth.admin, id)), verification, handover }, { headers: { "Cache-Control": "no-store" } })
}
