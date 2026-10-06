import { NextResponse } from "next/server"
import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { executeFinancialResolution, loadFinancialResolution } from "@/lib/orders/financial-resolution-server"
import type { FinancialChoice } from "@/lib/orders/financial-resolution"
import { prepareClaimUploads } from "@/lib/orders/claim-server"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import { PAYMENT_PROOF_BUCKET, getPaymentProofValidationError, sanitizePaymentProofFileName } from "@/lib/payments/transfer"

export const runtime = "nodejs"
type Context = { params: Promise<{ id: string }> }
const validId = async ({ params }: Context) => {
  const id = Number((await params).id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export async function GET(request: Request, context: Context) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const id = await validId(context)
  if (!id) return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  try {
    const result = await loadFinancialResolution(auth.admin, id)
    if (!result) return NextResponse.json({ error: "Pedido no encontrado." }, { status: 404 })
    return NextResponse.json({ financialOptions: result.options, status: result.status, amount: result.amount,
      requiresReturn: result.requiresReturn, mode: result.mode, product: result.returnContext.product,
      reception: result.returnContext.reception, receptionOptions: result.receptionOptions,
      notice: result.requiresReturn || result.returnContext.reception === "unavailable"
        ? "El pedido ya salió de BEYONIX. La resolución requiere devolución y recepción del producto." : null,
      resolution: result.resolution && { id: result.resolution.id,
        type: result.resolution.choice, status: result.resolution.status, amount: result.resolution.amount,
        detail: result.resolution.last_error } })
  } catch {
    return NextResponse.json({ error: "No se pudieron consultar las opciones financieras." }, { status: 500 })
  }
}

export async function POST(request: Request, context: Context) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const id = await validId(context)
  if (!id) return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  let body: { action?: string; choice?: FinancialChoice; confirmed?: boolean; reference?: string; observation?: string; receptionExceptionReason?: string }
  let file: File | null = null
  try {
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData()
      body = { action: String(form.get("action") ?? ""), choice: String(form.get("choice") ?? "") as FinancialChoice,
        confirmed: form.get("confirmed") === "true", reference: String(form.get("reference") ?? ""),
        observation: String(form.get("observation") ?? "") }
      file = form.get("file") instanceof File ? form.get("file") as File : null
    } else body = await request.json()
  } catch { return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 }) }
  if (body.confirmed !== true) return NextResponse.json({ error: "Confirmá la resolución antes de continuar." }, { status: 400 })
  try {
    if (body.action === "complete_manual") {
      const current = await loadFinancialResolution(auth.admin, id, false)
      if (!current?.resolution || current.resolution.choice !== "manual_refund") return NextResponse.json({ error: "No hay un reintegro manual pendiente." }, { status: 409 })
      if (current.resolution.status === "completed") return NextResponse.json({ status: "Completado" })
      if (current.resolution.status !== "manual_pending") return NextResponse.json({ error: "El reintegro aún no está listo." }, { status: 409 })
      let proof: { path: string; name: string; type: string; size: number } | null = null
      if (file) {
        const validationError = getPaymentProofValidationError(file)
        if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })
        const [upload] = await prepareClaimUploads([file])
        const path = `${id}/${crypto.randomUUID()}/${sanitizePaymentProofFileName(file.name)}`
        const { error: uploadError } = await auth.admin.storage.from(PAYMENT_PROOF_BUCKET).upload(path, upload.bytes,
          { contentType: upload.type, upsert: false })
        if (uploadError) throw new Error("No se pudo adjuntar el comprobante.")
        proof = { path, name: upload.name, type: upload.type, size: upload.size }
      }
      const { data, error } = await auth.admin.rpc("complete_manual_order_financial_refund", { p_resolution_id: current.resolution.id,
        p_actor_id: auth.user.id, p_reference: body.reference?.trim() || null, p_observation: body.observation?.trim() || null,
        p_proof: proof })
      if (proof) {
        const { data: stored, error: lookupError } = await auth.admin.from("order_refund_proofs")
          .select("file_path").eq("financial_resolution_id", current.resolution.id).maybeSingle()
        // Un timeout puede ocurrir después del commit: sólo se limpia si la DB
        // confirmó que este archivo no quedó asociado al reintegro.
        if (!lookupError && stored?.file_path !== `${PAYMENT_PROOF_BUCKET}/${proof.path}`) {
          await auth.admin.storage.from(PAYMENT_PROOF_BUCKET).remove([proof.path])
        }
      }
      if (error) throw new Error(error.message)
      return NextResponse.json({ status: "Completado", resolution: data })
    }
    if (body.action !== "resolve" && body.action !== "retry") return NextResponse.json({ error: "Acción inválida." }, { status: 400 })
    if (body.action === "resolve" && !["beyonix_credit", "mercadopago_refund", "manual_refund"].includes(body.choice ?? "")) {
      return NextResponse.json({ error: "Resolución inválida." }, { status: 400 })
    }
    if (body.action === "resolve" && body.receptionExceptionReason !== undefined) {
      const reason = typeof body.receptionExceptionReason === "string" ? body.receptionExceptionReason.trim() : ""
      if (reason.length < 10 || reason.length > 1000) {
        return NextResponse.json({ error: "Indicá el motivo de la excepción (mínimo 10 caracteres)." }, { status: 400 })
      }
      const current = await loadFinancialResolution(auth.admin, id, false)
      if (!current) return NextResponse.json({ error: "Pedido no encontrado." }, { status: 404 })
      if (current.returnContext.reception === "pending" && current.returnContext.claimId !== null) {
        if (!current.receptionOptions.some((option) => option.type === body.choice)) {
          return NextResponse.json({ error: "La opción ya no está disponible. Actualizá el pedido." }, { status: 409 })
        }
        // Excepción existente: queda auditada con motivo y Admin responsable en el reclamo.
        const { error: exceptionError } = await auth.admin.rpc("register_claim_financial_exception", {
          p_claim_id: current.returnContext.claimId, p_actor_id: auth.user.id, p_reason: reason,
        })
        if (exceptionError) throw new Error(exceptionError.message)
        await appendOrderAuditEvent(auth.admin, { orderId: id, actorType: "admin", actorId: auth.user.id,
          action: "financial_reception_exception", previousStatus: null, newStatus: null,
          metadata: { claimId: current.returnContext.claimId, reason, choice: body.choice } })
      }
    }
    const result = await executeFinancialResolution(auth.admin, id, auth.user.id,
      request.headers.get("authorization") ?? "", body.action === "resolve" ? body.choice ?? null : null, body.action === "retry")
    return NextResponse.json({ status: result.status, resolution: { id: result.id, type: result.choice, amount: result.amount },
      message: result.status === "requires_action" ? "Actualización pendiente. Reintentá cuando corresponda." : null },
      { status: result.status === "requires_action" ? 202 : 200 })
  } catch (error) {
    const detail = error instanceof Error ? error.message : ""
    const message = /^[A-Z][A-Z_]+/.test(detail) || !detail
      ? "No se pudo continuar. Revisá el pedido e intentá nuevamente."
      : detail
    return NextResponse.json({ error: message }, { status: 409 })
  }
}
