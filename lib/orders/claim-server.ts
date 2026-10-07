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
import { CUSTOMER_CLAIM_SHIPMENT_COLUMNS } from "./claim-shipment-view.ts"
import { describeClaimCancellationBlockers, parseClaimCancellationBlockerCodes } from "./claim-cancellation.ts"
import { sendOrderStatusEmail } from "../email/send-order-status-email.ts"
import { isSafeUploadedPdf } from "../security/uploaded-pdf.ts"

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
  CLAIM_EXPIRED: [409, "El plazo de este canal de reclamo ya finalizó. Escribinos desde Contacto y revisamos el caso."],
  CLAIM_INELIGIBLE: [409, "Este pedido no admite esta solicitud en su estado actual."],
  CLAIM_INVALID_ITEMS: [400, "Revisá los productos y cantidades del reclamo."],
  CLAIM_ITEMS_LOCKED: [409, "Los productos ya están vinculados a una recepción o una nota de crédito y no pueden modificarse."],
  CLAIM_TRANSITION: [409, "El cambio de estado no está permitido."],
  CLAIM_INVALID_AMOUNT: [400, "El importe no es válido para este pedido."],
  CLAIM_ECONOMIC_CLOSE: [409, "Confirmá la resolución desde la gestión de reintegro o nota de crédito."],
  CLAIM_REPLACEMENT_REQUIRED: [409, "Primero registrá un reemplazo para los productos de este reclamo antes de confirmar el envío o finalizarlo."],
  CLAIM_RESOLUTION_LOCKED: [409, "La resolución económica ya está en proceso y no puede reemplazarse."],
  CLAIM_CREDIT_PENDING: [409, "Primero debe autorizarse la nota de crédito y acreditarse el saldo."],
  CLAIM_REFUND_PENDING: [409, "Primero registrá el reintegro y su comprobante en la gestión de reintegros del pedido."],
  CLAIM_INVALID: [400, "Revisá los datos de la solicitud."],
  INVALID_REFUND_DETAILS: [400, "La referencia o la observación son demasiado largas. Acortalas e intentá de nuevo."],
  MERCADOPAGO_REQUIRES_REAL_REFUND: [409, "Este pedido se pagó con Mercado Pago: reintegralo desde el botón de Mercado Pago, no con un comprobante manual."],
  CLAIM_CANCELLATION_ACTION: [409, "La cancelación debe aprobarse o rechazarse desde su acción específica."],
  ANDREANI_CREATION_IN_PROGRESS: [
    409,
    "El pedido tiene una creación de envío en curso o pendiente de conciliación. Resolvé primero el estado de Andreani antes de cancelar.",
  ],
  ANDREANI_RECONCILIATION_REQUIRED: [
    409,
    "El pedido tiene una creación de envío en curso o pendiente de conciliación. Resolvé primero el estado de Andreani antes de cancelar.",
  ],
  // record_order_item_return_reception / process_claim_return_inventory
  // (Auditoría 4/7): antes caían al 500 genérico porque no estaban acá.
  RETURN_FORBIDDEN: [403, "No tenés permisos para registrar esta recepción."],
  RETURN_IDEMPOTENCY_KEY_REQUIRED: [400, "Falta la clave de idempotencia de la recepción."],
  "No se encontró el producto dentro del pedido.": [404, "No se encontró el producto dentro del pedido."],
  "Las cantidades de la devolución no pueden ser negativas.": [400, "Las cantidades de la devolución no pueden ser negativas."],
  "Indicá el motivo de la baja o pérdida.": [400, "Indicá el motivo de la baja."],
  "Indicá al menos una unidad recibida para registrar la devolución.": [400, "Indicá al menos una unidad recibida para registrar la devolución."],
  // Logística de postventa (20260928100000).
  CLAIM_LOGISTICS_FORBIDDEN: [403, "Sólo un administrador puede gestionar la logística del reclamo."],
  CLAIM_LOGISTICS_OPEN: [409, "La logística del reclamo sigue en curso: hay unidades en Andreani, sin inspeccionar, reservas sin resolver u operaciones abiertas."],
  CLAIM_LOGISTICS_INCIDENT: [409, "Hay un problema abierto en las unidades del reclamo. Resolvelo antes de continuar."],
  CLAIM_LOGISTICS_LOCKED: [409, "La logística física ya empezó: la resolución no puede cambiarse desde acá."],
  CLAIM_REOPEN_REASON_REQUIRED: [400, "Escribí el motivo de la corrección (mínimo 10 caracteres)."],
  CLAIM_REOPEN_NOT_ALLOWED: [409, "Este reclamo no se puede volver a revisar."],
  CLAIM_REOPEN_HAS_EFFECTS: [409, "El reclamo ya tuvo movimientos reales (nota de crédito, reemplazo, saldo, Andreani o stock): no se puede volver a revisar."],
  CLAIM_CANCEL_REASON_REQUIRED: [400, "Escribí el motivo de la cancelación (mínimo 10 caracteres)."],
  CLAIM_CANCEL_NOT_ALLOWED: [409, "Este caso se cierra desde su propio circuito, no se cancela desde acá."],
  CLAIM_ORIGINAL_NOT_RETURNED: [409, "El reemplazo fue entregado pero el producto original no volvió a BEYONIX. Registrá su recepción o la excepción explícita."],
  CLAIM_LOGISTICS_NOT_ALLOWED: [409, "Esta operación no corresponde a la solución aceptada del reclamo."],
  CLAIM_LOGISTICS_NOT_NEEDED: [409, "No quedan unidades en poder del cliente para esta operación."],
  CLAIM_LOGISTICS_ATTEMPTS: [409, "Se alcanzó el máximo de intentos logísticos para este reclamo."],
  CLAIM_LOGISTICS_NOTE_REQUIRED: [400, "Indicá el motivo (mínimo 10 caracteres; 5 para problemas y llegadas con novedad)."],
  CLAIM_LOGISTICS_INVALID: [400, "Revisá la acción, el producto y la cantidad."],
  CLAIM_LOGISTICS_IDEMPOTENCY_KEY_REQUIRED: [400, "La operación no tiene una clave de idempotencia válida."],
  CLAIM_LOGISTICS_IDEMPOTENCY_CONFLICT: [409, "Esta operación ya se registró con otros datos. Actualizá el reclamo."],
  CLAIM_UNITS_NOT_AVAILABLE: [409, "No hay unidades en ese estado para registrar esa cantidad. Actualizá el reclamo."],
  CLAIM_EXCHANGE_STATE: [409, "El cambio sólo puede marcarse como no completado mientras el producto nuevo está en manos de Andreani."],
  CLAIM_SHIPMENT_NOT_FOUND: [404, "El reclamo no tiene esa operación Andreani."],
  CLAIM_SHIPMENT_CLOSED: [409, "Esta operación ya está cerrada."],
  CLAIM_SHIPMENT_IN_FLIGHT: [409, "La operación se está generando o requiere conciliación: no puede cancelarse."],
  CLAIM_SHIPMENT_ALREADY_MOVING: [409, "Andreani ya tiene el producto: la operación no puede cancelarse."],
  CLAIM_LOGISTICS_BRANCH_REQUIRED: [400, "Elegí una sucursal Andreani válida para la operación."],
  CLAIM_LOGISTICS_PLAN_LOCKED: [409, "Ya hubo una operación Andreani: cambiar de método requiere un motivo (mínimo 10 caracteres)."],
  CLAIM_LOGISTICS_RESERVATION_ACTIVE: [409, "Hay stock reservado para el reemplazo: liberá la reserva (con motivo) antes de cambiar el método."],
  CLAIM_LOGISTICS_CREDIT_NOTE_ACTIVE: [409, "El reclamo tiene una nota de crédito vigente: el método no se puede cambiar."],
  CLAIM_LOGISTICS_REQUIRES_INSPECTION: [409, "El reemplazo se autoriza cuando el producto original fue recibido e inspeccionado sin problemas."],
  CLAIM_LOGISTICS_LEGACY: [409, "Este reclamo es anterior al circuito por sucursal y ya tuvo movimientos: continuá con su flujo original."],
  CLAIM_INSPECTION_NOT_RESTOCKABLE: [409, "Un paquete vacío o un producto distinto nunca vuelve a stock: registralo como baja."],
  CLAIM_MONEY_INCIDENT_OPEN: [409, "Hay un problema o una revisión abierta en el reclamo: resolvelo antes de la nota de crédito o el reintegro."],
  CLAIM_MONEY_RETURN_PENDING: [409, "El producto todavía no volvió a BEYONIX o no terminó su inspección. Registrá la recepción e inspección, o la excepción administrativa con su motivo."],
}

export function claimErrorResponse(error: unknown) {
  const candidate = error && typeof error === "object" ? error as { message?: unknown; code?: unknown } : null
  const message = typeof candidate?.message === "string" ? candidate.message : ""
  const known = CLAIM_ERRORS[message]
  if (known) return NextResponse.json({ error: known[1] }, { status: known[0] })
  // Cancelar reclamo con efectos pendientes: la base devuelve los códigos en
  // el detalle; al Admin le llega qué resolver, en lenguaje simple.
  if (message === "CLAIM_CANCEL_BLOCKED") {
    const details = typeof (candidate as { details?: unknown } | null)?.details === "string" ? (candidate as { details: string }).details : ""
    return NextResponse.json({
      error: "No se puede cancelar todavía.",
      blockers: describeClaimCancellationBlockers(details),
      // Códigos para que la interfaz ofrezca el acceso directo a cada uno.
      blockerCodes: parseClaimCancellationBlockerCodes(details),
    }, { status: 409 })
  }
  if (candidate?.code === "23505") return NextResponse.json({ error: CLAIM_ERRORS.CLAIM_EXISTS[1] }, { status: 409 })
  // record_order_item_return_reception: "RETURN_EXCEEDS_REMAINING: quedan N
  // unidad(es) disponibles..." -- prefijo fijo que controlamos nosotros, el
  // resto son sólo números, seguro de mostrar directamente al admin.
  const exceedsRemaining = message.match(/^RETURN_EXCEEDS_REMAINING:\s*(.+)/)
  if (exceedsRemaining) return NextResponse.json({ error: exceedsRemaining[1] }, { status: 409 })
  console.error("CLAIM_OPERATION_FAILED", { code: candidate?.code ?? "unexpected" })
  return NextResponse.json({ error: "No se pudo completar la solicitud. Revisá el seguimiento antes de reintentar." }, { status: 500 })
}

export async function prepareClaimUploads(files: File[]): Promise<ClaimUpload[]> {
  const uploads: ClaimUpload[] = []
  for (const file of files) {
    if (getClaimFileValidationError(file)) throw new Error("CLAIM_INVALID")
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (isClaimFileSignatureMismatch(bytes, file.type)) throw new Error("CLAIM_INVALID")
    if (file.type === "application/pdf" && !(await isSafeUploadedPdf(bytes))) throw new Error("CLAIM_INVALID")
    uploads.push({ name: file.name, type: file.type, size: file.size, bytes })
  }
  return uploads
}

export async function signClaim(admin: Admin, claim: SupabaseOrderClaim) {
  return (await signClaims(admin, [claim]))[0]
}

export async function signClaims(admin: Admin, claims: SupabaseOrderClaim[]) {
  const files = claims.flatMap((claim) => claim.order_claim_files ?? [])
  const paths = files.map((file) => file.file_path.replace(/^order-claim-evidence\//, ""))
  const { data } = paths.length
    ? await admin.storage.from(ORDER_CLAIM_BUCKET).createSignedUrls(paths, 300)
    : { data: [] }
  const urls = new Map((data ?? []).map((entry) => [entry.path, entry.signedUrl]))
  return claims.map((claim) => ({ ...claim, order_claim_files: (claim.order_claim_files ?? []).map((file) => ({
    ...file, signedUrl: urls.get(file.file_path.replace(/^order-claim-evidence\//, "")) ?? null,
  })) }))
}

/** Admin: reclamo con su logística completa (tramos y unidades). */
export const ADMIN_CLAIM_SELECT = "*, order_claim_files(*), order_claim_messages(*), order_claim_shipments(*), order_claim_units(*)"
/** Cliente: sólo campos seguros de los tramos; nunca contrato, ambiente, costo, errores ni unidades. */
export const CUSTOMER_CLAIM_SELECT = `*, order_claim_files(*), order_claim_messages(*), order_claim_shipments(${CUSTOMER_CLAIM_SHIPMENT_COLUMNS})`

export async function getClaimResult(admin: Admin, claimId: number, audience: "admin" | "customer" = "admin") {
  const { data, error } = audience === "admin"
    ? await admin.from("order_claims").select(ADMIN_CLAIM_SELECT).eq("id", claimId).single()
    : await admin.from("order_claims").select(CUSTOMER_CLAIM_SELECT).eq("id", claimId).single()
  if (error || !data) return claimErrorResponse(error?.code === "PGRST116" ? new Error("CLAIM_NOT_FOUND") : error)
  return NextResponse.json({ claim: await signClaim(admin, data as SupabaseOrderClaim) })
}

/** Sólo limpia intentos conocidos y fallidos; nunca borra metadata ni evidencia histórica. */
export async function cleanClaimOperation(admin: Admin, operationId: string) {
  const { data, error } = await admin.from("order_claim_operations").select("file_paths,status,bucket_id,expires_at").eq("id", operationId).single()
  if (error || !data || data.status !== "failed") return false
  const paths = data.file_paths as string[]
  if (paths.length) {
    const { error: storageError } = await admin.storage.from(data.bucket_id).remove(paths)
    if (storageError) return false
  }
  const { data: cleaned, error: updateError } = await admin.from("order_claim_operations").update({ status: "cleaned" })
    .eq("id", operationId).eq("status", "failed").eq("expires_at", data.expires_at).select("id").maybeSingle()
  return !updateError && Boolean(cleaned)
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
  // Reclamo del cliente: nunca la logística interna (contratos, costos, errores).
  const result = (claimId: number) => kind === "claim" ? getClaimResult(admin, claimId, "customer") : refundResult(admin, orderId)
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
    }) : await admin.rpc("commit_order_refund_proof", {
      p_operation_id: operation.id, p_actor_id: actorId, p_file: {
        ...fileMetadata[0],
        expected_note_ids: payload.expectedNoteIds,
        reference: payload.reference,
        refund_date: payload.refundDate,
        notes: payload.notes,
      },
    })
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
