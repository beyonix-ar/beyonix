import "server-only"

import { createHash, randomUUID } from "node:crypto"
import { NextResponse } from "next/server.js"
import {
  ORDER_CLAIM_BUCKET,
  getClaimFileValidationError,
  isClaimFileSignatureMismatch,
} from "../order-claims.ts"
import type { createAdminClient } from "../supabase/admin"
import type { SupabaseOrderClaim } from "../supabase/types"
import { sendOrderStatusEmail } from "../email/send-order-status-email.ts"
import { PDFDocument } from "pdf-lib"

type Admin = ReturnType<typeof createAdminClient>
export type ClaimUpload = { name: string; type: string; size: number; bytes: Uint8Array }

const CLAIM_ERRORS: Record<string, [number, string]> = {
  CLAIM_FORBIDDEN: [403, "No tenés permisos para esta solicitud."],
  CLAIM_NOT_FOUND: [404, "No encontramos el reclamo."],
  CLAIM_CONFLICT: [409, "El reclamo cambió o el envío está en proceso. Actualizá el seguimiento antes de reintentar."],
  CLAIM_TERMINAL: [409, "El reclamo ya está finalizado y no admite cambios."],
  CLAIM_EXISTS: [409, "El pedido ya tiene una solicitud en curso o un reclamo formal registrado."],
  CLAIM_WAIT_REPLY: [409, "Mensaje enviado. Esperá la respuesta de BEYONIX para continuar."],
  CLAIM_DELIVERY_DATE: [409, "Falta confirmar la fecha de entrega del pedido."],
  CLAIM_EXPIRED: [409, "El plazo para este tipo de reclamo ya finalizó."],
  CLAIM_INELIGIBLE: [409, "Este pedido no admite esta solicitud en su estado actual."],
  CLAIM_INVALID_ITEMS: [400, "Revisá los productos y cantidades del reclamo."],
  CLAIM_ITEMS_LOCKED: [409, "Los productos ya están vinculados a una recepción o una nota de crédito y no pueden modificarse."],
  CLAIM_TRANSITION: [409, "El cambio de estado no está permitido."],
  CLAIM_INVALID_AMOUNT: [400, "El importe no es válido para este pedido."],
  CLAIM_ECONOMIC_CLOSE: [409, "Confirmá la resolución desde la gestión de reintegro o nota de crédito."],
  CLAIM_RESOLUTION_LOCKED: [409, "La resolución económica ya está en proceso y no puede reemplazarse."],
  CLAIM_CREDIT_PENDING: [409, "Primero debe autorizarse la nota de crédito y acreditarse el saldo."],
  CLAIM_REFUND_PENDING: [409, "Primero registrá el reintegro y su comprobante en la gestión de reintegros del pedido."],
  CLAIM_INVALID: [400, "Revisá los datos de la solicitud."],
  CLAIM_CANCELLATION_ACTION: [409, "La cancelación debe aprobarse o rechazarse desde su acción específica."],
}

export function claimErrorResponse(error: unknown) {
  const candidate = error && typeof error === "object" ? error as { message?: unknown; code?: unknown } : null
  const message = typeof candidate?.message === "string" ? candidate.message : ""
  const known = CLAIM_ERRORS[message]
  if (known) return NextResponse.json({ error: known[1] }, { status: known[0] })
  if (candidate?.code === "23505") return NextResponse.json({ error: CLAIM_ERRORS.CLAIM_EXISTS[1] }, { status: 409 })
  console.error("CLAIM_OPERATION_FAILED", { code: candidate?.code ?? "unexpected" })
  return NextResponse.json({ error: "No se pudo completar la solicitud. Revisá el seguimiento antes de reintentar." }, { status: 500 })
}

export async function prepareClaimUploads(files: File[]): Promise<ClaimUpload[]> {
  const uploads: ClaimUpload[] = []
  for (const file of files) {
    if (getClaimFileValidationError(file)) throw new Error("CLAIM_INVALID")
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (isClaimFileSignatureMismatch(bytes, file.type)) throw new Error("CLAIM_INVALID")
    if (file.type === "application/pdf") {
      try {
        const document = await PDFDocument.load(bytes, { updateMetadata: false })
        if (!document.getPageCount()) throw new Error("Empty PDF")
      } catch { throw new Error("CLAIM_INVALID") }
    }
    uploads.push({ name: file.name, type: file.type, size: file.size, bytes })
  }
  return uploads
}

export async function signClaim(admin: Admin, claim: SupabaseOrderClaim) {
  const files = claim.order_claim_files ?? []
  const paths = files.map((file) => file.file_path.replace(/^order-claim-evidence\//, ""))
  const { data } = paths.length
    ? await admin.storage.from(ORDER_CLAIM_BUCKET).createSignedUrls(paths, 300)
    : { data: [] }
  const urls = new Map((data ?? []).map((entry) => [entry.path, entry.signedUrl]))
  return { ...claim, order_claim_files: files.map((file, index) => ({ ...file, signedUrl: urls.get(paths[index]) ?? null })) }
}

export async function getClaimResult(admin: Admin, claimId: number) {
  const { data, error } = await admin.from("order_claims").select("*, order_claim_files(*), order_claim_messages(*)").eq("id", claimId).single()
  if (error || !data) return claimErrorResponse(error)
  return NextResponse.json({ claim: await signClaim(admin, data as SupabaseOrderClaim) })
}

/** Sólo limpia intentos conocidos y fallidos; nunca borra metadata ni evidencia histórica. */
export async function cleanClaimOperation(admin: Admin, operationId: string) {
  const { data, error } = await admin.from("order_claim_operations").select("file_paths,status,bucket_id").eq("id", operationId).single()
  if (error || !data || data.status !== "failed") return false
  const paths = data.file_paths as string[]
  if (paths.length) {
    const { error: storageError } = await admin.storage.from(data.bucket_id).remove(paths)
    if (storageError) return false
  }
  const { error: updateError } = await admin.from("order_claim_operations").update({ status: "cleaned" }).eq("id", operationId).eq("status", "failed")
  return !updateError
}

export async function submitCustomerClaim(admin: Admin, actorId: string, orderId: number, payload: Record<string, unknown>, uploads: ClaimUpload[]) {
  return submitClaimUploadOperation(admin, actorId, orderId, payload, uploads, "claim")
}

async function refundResult(admin: Admin, orderId: number) {
  const { data: order, error } = await admin.from("ordenes").select("*").eq("id", orderId).single()
  if (error || !order) return claimErrorResponse(error)
  const path = String(order.refund_proof_url ?? "").replace(/^payment-proofs\//, "")
  const { data } = path ? await admin.storage.from("payment-proofs").createSignedUrl(path, 300) : { data: null }
  return NextResponse.json({ order, signedUrl: data?.signedUrl ?? null })
}

export async function submitClaimUploadOperation(admin: Admin, actorId: string, orderId: number, payload: Record<string, unknown>, uploads: ClaimUpload[], kind: "claim" | "refund") {
  const bucket = kind === "claim" ? ORDER_CLAIM_BUCKET : "payment-proofs"
  const result = (claimId: number) => kind === "claim" ? getClaimResult(admin, claimId) : refundResult(admin, orderId)
  const requestHash = createHash("sha256").update(JSON.stringify({ orderId, payload, kind }))
  for (const upload of uploads) requestHash.update(JSON.stringify([upload.name, upload.type, upload.size])).update(upload.bytes)
  const attemptId = randomUUID()
  const paths = uploads.map((file, index) => `${actorId}/${attemptId}/${index}.${file.name.split(".").pop()!.toLowerCase()}`)
  const { data: operation, error: beginError } = await admin.rpc("begin_order_claim_operation", {
    p_id: attemptId, p_actor_id: actorId, p_order_id: orderId, p_request_key: requestHash.digest("hex"), p_file_paths: paths,
    p_bucket_id: bucket,
  })
  if (beginError || !operation) return claimErrorResponse(beginError)
  if (operation.status === "committed") return result(Number(operation.claim_id))
  if (!operation.acquired) return claimErrorResponse(new Error("CLAIM_CONFLICT"))
  try {
    for (let index = 0; index < uploads.length; index++) {
      const { error } = await admin.storage.from(bucket).upload(paths[index], uploads[index].bytes, { contentType: uploads[index].type, upsert: false })
      if (error) throw error
    }
    const fileMetadata = uploads.map(({ name, type, size }, index) => ({ name, type, size, path: paths[index] }))
    const { data: claimId, error } = kind === "claim" ? await admin.rpc("commit_customer_order_claim", {
      p_operation_id: operation.id, p_actor_id: actorId, p_payload: payload, p_files: fileMetadata,
    }) : await admin.rpc("commit_order_refund_proof", { p_operation_id: operation.id, p_actor_id: actorId, p_file: fileMetadata[0] })
    if (error || !claimId) throw error ?? new Error("CLAIM_CONFLICT")
    if (kind === "refund" || !payload.claimId) {
      const { data: recipient } = await admin.from("ordenes").select("cliente_email").eq("id", orderId).single()
      await sendOrderStatusEmail({
        to: recipient?.cliente_email,
        subject: kind === "refund" ? "Reintegro registrado | BEYONIX" : "Solicitud recibida | BEYONIX",
        html: kind === "refund"
          ? "<p>Registramos el reintegro de tu pedido. Podés ver el comprobante desde tu cuenta.</p>"
          : "<p>Recibimos tu solicitud de ayuda. Podés consultar las respuestas y el seguimiento desde tu cuenta.</p>",
      })
    }
    return result(Number(claimId))
  } catch (error) {
    // Este CAS espera cualquier commit en vuelo; jamás elimina objetos de un commit exitoso.
    const { data: failed, error: failError } = await admin.from("order_claim_operations").update({ status: "failed" }).eq("id", operation.id).eq("status", "uploading").select("id").maybeSingle()
    if (!failError && failed) await cleanClaimOperation(admin, operation.id)
    if (!failError && !failed) {
      const { data: completed } = await admin.from("order_claim_operations").select("status,claim_id").eq("id", operation.id).single()
      if (completed?.status === "committed") return result(Number(completed.claim_id))
    }
    return claimErrorResponse(error)
  }
}
