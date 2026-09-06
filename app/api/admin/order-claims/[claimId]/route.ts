import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { claimErrorResponse, getClaimResult } from "@/lib/orders/claim-server"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { escapeXml } from "@/lib/arca/xml"
import { ORDER_CLAIM_STATUSES, ORDER_CLAIM_RESOLUTIONS } from "@/lib/order-claims"

export async function GET(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error
  const id = Number((await params).claimId)
  if (!Number.isSafeInteger(id) || id <= 0) return claimErrorResponse(new Error("CLAIM_INVALID"))
  return getClaimResult(auth.admin, id)
}

export async function PATCH(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  try {
    const auth = await requireOperator(request)
    if ("error" in auth) return auth.error
    const id = Number((await params).claimId)
    if (!Number.isSafeInteger(id) || id <= 0) return claimErrorResponse(new Error("CLAIM_INVALID"))
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      return NextResponse.json({ error: "Los comprobantes se registran desde la gestión de reintegros del pedido." }, { status: 410 })
    }
    const body: unknown = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) return claimErrorResponse(new Error("CLAIM_INVALID"))
    const input = body as Record<string, unknown>
    if (input.action && !["update","approve_cancellation","reject_cancellation","mark_refund_done","mark_credit_note_issued"].includes(String(input.action))) {
      return NextResponse.json({ error: "Esta acción ya no está disponible." }, { status: 410 })
    }
    const expected = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt : ""
    if (!Number.isFinite(Date.parse(expected))) return claimErrorResponse(new Error("CLAIM_CONFLICT"))
    const patch: Record<string, unknown> = {}
    const allowed = ["action","status","resolution","admin_response","rejection_reason","append_message","credit_note_amount"]
    for (const key of allowed) if (input[key] !== undefined) patch[key] = input[key]
    if (patch.status !== undefined && !ORDER_CLAIM_STATUSES.some((status) => status === patch.status) ||
        patch.resolution != null && !ORDER_CLAIM_RESOLUTIONS.some((resolution) => resolution === patch.resolution) ||
        patch.append_message !== undefined && typeof patch.append_message !== "boolean" ||
        input.offered_resolutions !== undefined && (!Array.isArray(input.offered_resolutions) || input.offered_resolutions.length > 0)) return claimErrorResponse(new Error("CLAIM_INVALID"))
    if (["admin_response","rejection_reason"].some((key) => patch[key] !== undefined && (typeof patch[key] !== "string" || String(patch[key]).length > 2000))) return claimErrorResponse(new Error("CLAIM_INVALID"))
    if (patch.credit_note_amount !== undefined && (typeof patch.credit_note_amount !== "number" || !Number.isFinite(patch.credit_note_amount))) return claimErrorResponse(new Error("CLAIM_INVALID_AMOUNT"))
    const { data: claim, error } = await auth.admin.rpc("mutate_admin_order_claim", {
      p_claim_id: id, p_actor_id: auth.user.id, p_expected_updated_at: expected, p_patch: patch,
    })
    if (error || !claim) return claimErrorResponse(error)
    if (patch.append_message || ["cerrado","rechazado"].includes(claim.status) || patch.action === "mark_credit_note_issued") {
      const { data: order } = await auth.admin.from("ordenes").select("cliente_email").eq("id", claim.order_id).single()
      await sendOrderStatusEmail({
        to: order?.cliente_email,
        subject: "Novedades sobre tu reclamo BEYONIX",
        html: `<p>${escapeXml(String(claim.admin_response || "Actualizamos tu reclamo. Podés consultar el seguimiento desde tu cuenta.")).replace(/\n/g, "<br />")}</p>`,
      })
    }
    return getClaimResult(auth.admin, id)
  } catch (error) {
    return claimErrorResponse(error instanceof SyntaxError ? new Error("CLAIM_INVALID") : error)
  }
}
