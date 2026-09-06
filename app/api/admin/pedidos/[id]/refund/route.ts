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
    const file = form.get("file")
    if (!(file instanceof File) || !["image/jpeg","application/pdf"].includes(file.type) || getPaymentProofValidationError(file)) return NextResponse.json({ error: "Subí un comprobante JPG, JPEG o PDF válido." }, { status: 400 })
    const { data: notes, error } = await auth.admin.from("order_credit_notes").select("id").eq("order_id", orderId).eq("status", "authorized").eq("destination", "external_refund").limit(1)
    if (error || !notes?.length) return claimErrorResponse(new Error("CLAIM_REFUND_PENDING"))
    return await submitClaimUploadOperation(auth.admin, auth.user.id, orderId, {}, await prepareClaimUploads([file]), "refund")
  } catch (error) { return claimErrorResponse(error) }
}
