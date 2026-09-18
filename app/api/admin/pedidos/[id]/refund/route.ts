import { NextResponse } from "next/server"
import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { claimErrorResponse, prepareClaimUploads, submitClaimUploadOperation } from "@/lib/orders/claim-server"
import { PAYMENT_PROOF_BUCKET, getPaymentProofValidationError } from "@/lib/payments/transfer"

export const maxDuration = 300

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error
  const orderId = Number((await params).id)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return claimErrorResponse(new Error("CLAIM_INVALID"))
  const { data: order, error } = await auth.admin.from("ordenes").select("id,refund_proof_url,refund_proof_file_name").eq("id", orderId).single()
  if (error || !order) return claimErrorResponse(new Error("CLAIM_NOT_FOUND"))
  const { data: proofs, error: proofsError } = await auth.admin.from("order_refund_proofs").select("*").eq("order_id", orderId).order("created_at", { ascending: false })
  if (proofsError) return claimErrorResponse(proofsError)
  const sign = async (path: string | null) => {
    if (!path) return null
    const { data } = await auth.admin.storage.from(PAYMENT_PROOF_BUCKET).createSignedUrl(path.replace(/^payment-proofs\//, ""), 300)
    return data?.signedUrl ?? null
  }
  return NextResponse.json({
    signedUrl: await sign(order.refund_proof_url), fileName: order.refund_proof_file_name,
    proofs: await Promise.all((proofs ?? []).map(async (proof) => ({ ...proof, signedUrl: await sign(proof.file_path) }))),
  })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin(request)
    if ("error" in auth) return auth.error
    const orderId = Number((await params).id)
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return claimErrorResponse(new Error("CLAIM_INVALID"))
    const form = await request.formData()
    // expectedNoteIds sólo es obligatorio cuando la NC es la fuente del
    // importe (rama con NC de commit_order_refund_proof). El pedido que
    // nunca requirió NC (credit_note_required=false, migración
    // 20260917130000) no tiene notas que "esperar" -- se registra el
    // reintegro directo contra el dinero externo confirmado.
    const expectedNoteIds: unknown = JSON.parse(String(form.get("expectedNoteIds") ?? "[]"))
    if (!Array.isArray(expectedNoteIds) || (expectedNoteIds.length > 0 && (new Set(expectedNoteIds).size !== expectedNoteIds.length ||
      expectedNoteIds.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))))
      return claimErrorResponse(new Error("CLAIM_CONFLICT"))
    const file = form.get("file")
    if (!(file instanceof File) || !["image/jpeg","application/pdf"].includes(file.type) || getPaymentProofValidationError(file)) return NextResponse.json({ error: "Subí un comprobante JPG, JPEG o PDF válido." }, { status: 400 })

    const { data: order, error: orderError } = await auth.admin.from("ordenes").select("credit_note_required").eq("id", orderId).single()
    if (orderError || !order) return claimErrorResponse(new Error("CLAIM_NOT_FOUND"))

    if (order.credit_note_required) {
      if (!expectedNoteIds.length) return claimErrorResponse(new Error("CLAIM_REFUND_PENDING"))
      const { data: notes, error } = await auth.admin.from("order_credit_notes").select("id").eq("order_id", orderId).eq("status", "authorized").eq("destination", "external_refund").limit(1)
      if (error || !notes?.length) return claimErrorResponse(new Error("CLAIM_REFUND_PENDING"))
    }

    const reference = String(form.get("reference") ?? "").trim().slice(0, 120)
    const refundDate = String(form.get("refundDate") ?? "").trim()
    const notesText = String(form.get("notes") ?? "").trim().slice(0, 600)
    if (refundDate && !/^\d{4}-\d{2}-\d{2}$/.test(refundDate)) return claimErrorResponse(new Error("CLAIM_INVALID"))

    return await submitClaimUploadOperation(auth.admin, auth.user.id, orderId, {
      expectedNoteIds: [...expectedNoteIds].sort(),
      reference: reference || undefined,
      refundDate: refundDate || undefined,
      notes: notesText || undefined,
    }, await prepareClaimUploads([file]), "refund")
  } catch (error) { return claimErrorResponse(error instanceof SyntaxError ? new Error("CLAIM_INVALID") : error) }
}
