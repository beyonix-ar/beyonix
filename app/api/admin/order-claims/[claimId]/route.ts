import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { getRemainingCreditableAmount } from "@/lib/orders/credit-note-remaining"
import {
  CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS,
  ORDER_CLAIM_BUCKET,
  ORDER_CLAIM_RESOLUTIONS,
  ORDER_CLAIM_STATUSES,
  getClaimFileValidationError,
  sanitizeClaimFileName,
} from "@/lib/order-claims"

function stripBucket(path: string) {
  return path.startsWith(`${ORDER_CLAIM_BUCKET}/`)
    ? path.slice(ORDER_CLAIM_BUCKET.length + 1)
    : path
}

function normalizeStoredPath(path: string) {
  return path.startsWith(`${ORDER_CLAIM_BUCKET}/`)
    ? path
    : `${ORDER_CLAIM_BUCKET}/${path}`
}

function isOrderDispatched(order: {
  estado?: string | null
  tracking_number?: string | null
  andreani_tracking?: string | null
  andreani_envio_id?: string | null
  andreani_estado?: string | null
}) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()
  const dispatchedStatuses = [
    "enviado",
    "en_camino",
    "visita_fallida",
    "en_sucursal",
    "retiro_pendiente",
    "retiro_vencido",
    "en_devolucion",
    "devuelto_beyonix",
    "entregado",
  ]

  return (
    dispatchedStatuses.includes(estado) ||
    Boolean(order.tracking_number || order.andreani_tracking || order.andreani_envio_id) ||
    ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita", "entregado"].some(
      (status) => andreaniStatus.includes(status),
    )
  )
}

function isOrderInvoiced(order: {
  invoice_status?: string | null
  invoice_cae?: string | null
  invoice_number?: number | null
  invoice_point?: number | null
}) {
  return (
    order.invoice_status === "authorized" ||
    order.invoice_status === "processing" ||
    Boolean(order.invoice_cae) ||
    Boolean(order.invoice_number && order.invoice_point)
  )
}

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
}

async function getClaimOrderRecipient(admin: any, orderId: number) {
  const { data: order } = await admin
    .from("ordenes")
    .select("id, usuario_id, cliente_email, cliente_nombre")
    .eq("id", orderId)
    .maybeSingle()

  return order
}

async function notifyCustomer(
  admin: any,
  payload: {
    userId?: string | null
    type: string
    title: string
    body: string
    orderId: number
    sourceKey: string
  },
) {
  if (!payload.userId) return

  const { error } = await admin.from("customer_notifications").insert({
    user_id: payload.userId,
    type: payload.type,
    title: payload.title,
    body: payload.body,
    action_url: `/cuenta/compras/${payload.orderId}/ayuda`,
    order_id: payload.orderId,
    source_key: payload.sourceKey,
  })

  if (error && error.code !== "23505") {
    console.log("No se pudo crear notificación de cliente", error.message)
  }
}

async function notifyCancellationResolution(
  admin: any,
  payload: {
    claimId: number
    orderId: number
    approved: boolean
    message: string
  },
) {
  const order = await getClaimOrderRecipient(admin, payload.orderId)
  if (!order) return

  const orderCode = getOrderCode(payload.orderId)
  const title = payload.approved ? "Cancelación aprobada" : "Cancelación rechazada"
  const body = payload.approved
    ? `La compra ${orderCode} fue cancelada correctamente.`
    : `Revisamos la solicitud del pedido ${orderCode}.`

  await notifyCustomer(admin, {
    userId: order.usuario_id,
    type: payload.approved ? "cancellation_approved" : "cancellation_rejected",
    title,
    body,
    orderId: payload.orderId,
    sourceKey: `claim:${payload.claimId}:${payload.approved ? "cancellation-approved" : "cancellation-rejected"}`,
  })

  await sendOrderStatusEmail({
    to: order.cliente_email,
    subject: `${title} ${orderCode}`,
    html: `
      <h1>${title}</h1>
      <p>Hola ${order.cliente_nombre ?? ""}, ${body}</p>
      <p>${payload.message}</p>
    `,
  })
}

async function sendClaimUpdateEmail(
  admin: any,
  payload: {
    orderId: number
    title: string
    message: string
  },
) {
  const order = await getClaimOrderRecipient(admin, payload.orderId)
  if (!order) return

  await sendOrderStatusEmail({
    to: order.cliente_email,
    subject: `${payload.title} ${getOrderCode(payload.orderId)}`,
    html: `
      <h1>${payload.title}</h1>
      <p>Hola ${order.cliente_nombre ?? ""}, tenés una novedad sobre tu pedido ${getOrderCode(payload.orderId)}.</p>
      <p>${payload.message}</p>
    `,
  })
}

async function markOrderCreditNoteRequired(
  admin: any,
  orderId: number,
  creditNoteAmount?: number | null,
) {
  const payload: Record<string, unknown> = {
    credit_note_required: true,
    credit_note_status: "pending",
  }

  if (typeof creditNoteAmount === "number") {
    payload.credit_note_amount = Number(creditNoteAmount.toFixed(2))
  }

  const { error } = await admin
    .from("ordenes")
    .update(payload)
    .eq("id", orderId)
    .is("credit_note_cae", null)

  return error
}

async function uploadRefundProof(admin: any, claimId: number, userId: string, file: File) {
  const validationError = getClaimFileValidationError(file)
  if (validationError) return { error: validationError }

  if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
    return { error: "Subí una imagen o un PDF." }
  }

  const safeName = sanitizeClaimFileName(file.name)
  const path = `${claimId}/refund-proof-${Date.now()}-${safeName}`
  const { error: uploadError } = await admin.storage
    .from(ORDER_CLAIM_BUCKET)
    .upload(path, file, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) return { error: uploadError.message || "No se pudo subir el comprobante." }

  const { error: deleteError } = await admin
    .from("order_claim_files")
    .delete()
    .eq("claim_id", claimId)
    .eq("file_role", "comprobante_devolucion")

  if (deleteError) return { error: deleteError.message || "No se pudo reemplazar el comprobante anterior." }

  const { error: insertError } = await admin.from("order_claim_files").insert({
    claim_id: claimId,
    uploaded_by: userId,
    file_role: "comprobante_devolucion",
    file_name: file.name,
    file_path: normalizeStoredPath(path),
    mime_type: file.type || "application/octet-stream",
    file_size: file.size,
  })

  if (insertError) return { error: insertError.message || "No se pudo guardar el comprobante." }

  return { error: "" }
}

// Firma todos los archivos del reclamo en una sola llamada a Storage en vez
// de una por archivo (este endpoint es el que hace polling cada 20s).
async function attachSignedUrls(admin: any, claim: any) {
  const files = claim.order_claim_files ?? []
  const paths = files.map((file: any) => stripBucket(file.file_path))
  const signedUrlByPath = new Map<string, string | null>()

  if (paths.length) {
    const { data: signedUrls } = await admin.storage
      .from(ORDER_CLAIM_BUCKET)
      .createSignedUrls(paths, 300)
    for (const signed of signedUrls ?? []) {
      if (signed.path) signedUrlByPath.set(signed.path, signed.signedUrl ?? null)
    }
  }

  return {
    ...claim,
    order_claim_files: files.map((file: any) => ({
      ...file,
      signedUrl: signedUrlByPath.get(stripBucket(file.file_path)) ?? null,
    })),
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ claimId: string }> },
) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const { claimId } = await params
  const id = Number(claimId)
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Reclamo inválido." }, { status: 400 })
  }

  const { data, error } = await auth.admin
    .from("order_claims")
    .select("*, order_claim_files(*), order_claim_messages(*)")
    .eq("id", id)
    .maybeSingle()

  if (error || !data) {
    return NextResponse.json({ error: "No encontramos el reclamo." }, { status: 404 })
  }

  return NextResponse.json({ claim: await attachSignedUrls(auth.admin, data) })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ claimId: string }> },
) {
  const auth = await requireOperator(request)

  if ("error" in auth) return auth.error

  const { claimId } = await params
  const id = Number(claimId)

  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Reclamo inválido." }, { status: 400 })
  }

  const contentType = request.headers.get("content-type") ?? ""
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData()
    const action = String(formData.get("action") ?? "")

    if (action !== "upload_refund_proof") {
      return NextResponse.json({ error: "Acción inválida." }, { status: 400 })
    }

    const file = formData.get("file")
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Subí el comprobante de devolución." },
        { status: 400 },
      )
    }

    const uploadResult = await uploadRefundProof(auth.admin, id, auth.user.id, file)
    if (uploadResult.error) {
      return NextResponse.json({ error: uploadResult.error }, { status: 400 })
    }

    const { data: updatedClaim, error: claimError } = await auth.admin
      .from("order_claims")
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .eq("id", id)
      .single()

    if (claimError || !updatedClaim) {
      return NextResponse.json(
        { error: claimError?.message || "No se pudo actualizar el reclamo." },
        { status: 500 },
      )
    }

    return NextResponse.json({
      claim: await attachSignedUrls(auth.admin, updatedClaim),
    })
  }

  const body = (await request.json()) as {
    action?: unknown
    status?: unknown
    admin_response?: unknown
    rejection_reason?: unknown
    resolution?: unknown
    offered_resolutions?: unknown
    append_message?: unknown
    replacement_product?: unknown
    replacement_extra_cost?: unknown
    replacement_payment_link?: unknown
    replacement_shipping_company?: unknown
    replacement_tracking?: unknown
    coupon_code?: unknown
    credit_note_amount?: unknown
  }
  const status = String(body.status ?? "")
  const resolution = body.resolution ? String(body.resolution) : null
  const offeredResolutions = Array.isArray(body.offered_resolutions)
    ? Array.from(new Set(body.offered_resolutions.map((item) => String(item))))
    : []
  const adminResponse =
    typeof body.admin_response === "string"
      ? body.admin_response.trim().slice(0, 2000)
      : ""
  const rejectionReason =
    typeof body.rejection_reason === "string"
      ? body.rejection_reason.trim().slice(0, 1200)
      : ""
  const creditNoteAmount =
    body.credit_note_amount === null || body.credit_note_amount === undefined
      ? null
      : Number(body.credit_note_amount)

  const getUpdatedClaim = async (fallback: any) => {
    const { data: updatedClaim } = await auth.admin
      .from("order_claims")
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .eq("id", id)
      .single()

    return attachSignedUrls(auth.admin, updatedClaim ?? fallback)
  }

  if (body.action === "mark_credit_note_issued") {
    if (!["admin", "super_admin"].includes(auth.profile.rol)) {
      return NextResponse.json(
        { error: "No tenés permisos para confirmar una nota de crédito." },
        { status: 403 },
      )
    }

    const { data: currentClaim, error: currentClaimError } = await auth.admin
      .from("order_claims")
      .select("id, order_id, user_id, status, resolution, admin_response, last_admin_response_at, closed_at, admin_needs_action")
      .eq("id", id)
      .single()

    if (currentClaimError || !currentClaim) {
      return NextResponse.json(
        { error: currentClaimError?.message || "No encontramos el reclamo." },
        { status: 404 },
      )
    }

    if (currentClaim.resolution !== "cupon_descuento") {
      return NextResponse.json(
        { error: "Este reclamo no tiene una nota de crédito como resolución." },
        { status: 409 },
      )
    }

    const { data: order, error: orderError } = await auth.admin
      .from("ordenes")
      .select("id, credit_note_issued, credit_note_status, credit_note_cae, credit_note_number")
      .eq("id", currentClaim.order_id)
      .single()

    if (orderError || !order) {
      return NextResponse.json(
        { error: "No encontramos el pedido asociado." },
        { status: 404 },
      )
    }

    const creditNoteWasIssued =
      order.credit_note_issued === true &&
      order.credit_note_status === "authorized" &&
      Boolean(order.credit_note_cae) &&
      Boolean(order.credit_note_number)

    if (!creditNoteWasIssued) {
      return NextResponse.json(
        {
          error:
            "La nota de crédito todavía no fue emitida y autorizada por ARCA.",
        },
        { status: 409 },
      )
    }

    const { data: creditedMovement, error: creditedMovementError } =
      await auth.admin
        .from("customer_credit_movements")
        .select("id")
        .eq("order_id", currentClaim.order_id)
        .eq("claim_id", currentClaim.id)
        .eq("movement_type", "credit")
        .eq("source_type", "credit_note")
        .limit(1)
        .maybeSingle()

    if (creditedMovementError || !creditedMovement) {
      return NextResponse.json(
        {
          error:
            "La nota está autorizada, pero el saldo todavía no fue acreditado. No se puede informar al cliente como disponible.",
        },
        { status: 409 },
      )
    }

    if (["cerrado", "rechazado"].includes(currentClaim.status)) {
      return NextResponse.json(
        { error: "El reclamo ya está finalizado." },
        { status: 409 },
      )
    }

    const customerMessage = [
      "Estimado cliente:",
      "",
      "Se generó correctamente una nota de crédito y el saldo a favor ya fue acreditado en su cuenta. Podés verificarlo ingresando en Mi cuenta > Saldos.",
      "",
      "Ante cualquier duda, podés contactarnos a través de nuestras redes sociales.",
      "",
      "Saludos,",
      "BEYONIX",
    ].join("\n")
    const nowIso = new Date().toISOString()
    const { data: updatedClaim, error: updateError } = await auth.admin
      .from("order_claims")
      .update({
        status: "cerrado",
        resolution: "cupon_descuento",
        admin_response: customerMessage,
        last_admin_response_at: nowIso,
        closed_at: nowIso,
        admin_needs_action: false,
      })
      .eq("id", id)
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .single()

    if (updateError || !updatedClaim) {
      return NextResponse.json(
        { error: updateError?.message || "No se pudo confirmar la nota de crédito." },
        { status: 500 },
      )
    }

    const { error: messageError } = await auth.admin
      .from("order_claim_messages")
      .insert({
        claim_id: id,
        author_user_id: auth.user.id,
        author_role: auth.profile.rol,
        message: customerMessage,
      })

    if (messageError) {
      await auth.admin
        .from("order_claims")
        .update({
          status: currentClaim.status,
          admin_response: currentClaim.admin_response,
          last_admin_response_at: currentClaim.last_admin_response_at,
          closed_at: currentClaim.closed_at,
          admin_needs_action: currentClaim.admin_needs_action,
        })
        .eq("id", id)

      return NextResponse.json(
        { error: "No se pudo enviar el mensaje de confirmación al cliente." },
        { status: 500 },
      )
    }

    await notifyCustomer(auth.admin, {
      userId: currentClaim.user_id,
      type: "claim_credit_note_issued",
      title: "Nota de crédito emitida",
      body: `El saldo a favor del pedido ${getOrderCode(currentClaim.order_id)} ya está disponible en Mi cuenta > Saldos.`,
      orderId: currentClaim.order_id,
      sourceKey: `claim:${id}:credit-note-issued`,
    })

    await sendClaimUpdateEmail(auth.admin, {
      orderId: currentClaim.order_id,
      title: "Nota de crédito emitida",
      message: customerMessage.replace(/\n/g, "<br />"),
    })

    return NextResponse.json({ claim: await getUpdatedClaim(updatedClaim) })
  }

  if (body.action === "approve_cancellation") {
    const { data: currentClaim, error: currentClaimError } = await auth.admin
      .from("order_claims")
      .select("id, order_id, failure_type, status")
      .eq("id", id)
      .single()

    if (currentClaimError || !currentClaim) {
      return NextResponse.json(
        { error: currentClaimError?.message || "No encontramos la solicitud." },
        { status: 404 },
      )
    }

    if (currentClaim.failure_type !== "cancelar_compra") {
      return NextResponse.json(
        { error: "Esta acción sólo aplica a solicitudes de cancelación." },
        { status: 400 },
      )
    }

    if (["cerrado", "rechazado"].includes(currentClaim.status)) {
      return NextResponse.json(
        { error: "La solicitud de cancelación ya fue cerrada." },
        { status: 409 },
      )
    }

    const { data: order, error: orderError } = await auth.admin
      .from("ordenes")
      .select("id, estado, tracking_number, andreani_tracking, andreani_envio_id, andreani_estado, invoice_status, invoice_cae, invoice_number, invoice_point")
      .eq("id", currentClaim.order_id)
      .single()

    if (orderError || !order) {
      return NextResponse.json(
        { error: "No encontramos el pedido asociado." },
        { status: 404 },
      )
    }

    if (isOrderInvoiced(order)) {
      return NextResponse.json(
        { error: "No se puede aprobar la cancelación porque el pedido ya fue facturado." },
        { status: 409 },
      )
    }

    if (isOrderDispatched(order)) {
      return NextResponse.json(
        { error: "No se puede aprobar la cancelación porque el pedido ya fue despachado." },
        { status: 409 },
      )
    }

    const message = adminResponse || "BEYONIX aprobó la cancelación de la compra."

    const { data: updatedClaim, error: approveError } = await auth.admin.rpc(
      "approve_order_claim_cancellation",
      {
        p_claim_id: id,
        p_admin_id: auth.user.id,
        p_admin_role: auth.profile.rol,
        p_message: message,
      },
    )

    if (approveError || !updatedClaim) {
      return NextResponse.json(
        { error: approveError?.message || "No se pudo aprobar la cancelación." },
        { status: approveError?.code === "P0001" ? 409 : 500 },
      )
    }

    await notifyCancellationResolution(auth.admin, {
      claimId: id,
      orderId: currentClaim.order_id,
      approved: true,
      message,
    })

    return NextResponse.json({ claim: await getUpdatedClaim(updatedClaim) })
  }

  if (body.action === "reject_cancellation") {
    if (adminResponse.length < 5) {
      return NextResponse.json(
        { error: "Escribí el motivo del rechazo para que el cliente lo vea claro." },
        { status: 400 },
      )
    }

    const { data: currentClaim, error: currentClaimError } = await auth.admin
      .from("order_claims")
      .select("id, failure_type, status")
      .eq("id", id)
      .single()

    if (currentClaimError || !currentClaim) {
      return NextResponse.json(
        { error: currentClaimError?.message || "No encontramos la solicitud." },
        { status: 404 },
      )
    }

    if (currentClaim.failure_type !== "cancelar_compra") {
      return NextResponse.json(
        { error: "Esta acción sólo aplica a solicitudes de cancelación." },
        { status: 400 },
      )
    }

    if (["cerrado", "rechazado"].includes(currentClaim.status)) {
      return NextResponse.json(
        { error: "La solicitud de cancelación ya fue cerrada." },
        { status: 409 },
      )
    }

    const { data: updatedClaim, error: updateError } = await auth.admin
      .from("order_claims")
      .update({
        status: "rechazado",
        resolution: "rechazado",
        rejection_reason: adminResponse,
        admin_response: adminResponse,
        closed_at: new Date().toISOString(),
        admin_needs_action: false,
      })
      .eq("id", id)
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .single()

    if (updateError || !updatedClaim) {
      return NextResponse.json(
        { error: updateError?.message || "No se pudo rechazar la cancelación." },
        { status: 500 },
      )
    }

    await auth.admin.from("order_claim_messages").insert({
      claim_id: id,
      author_user_id: auth.user.id,
      author_role: auth.profile.rol,
      message: adminResponse,
    })

    await notifyCancellationResolution(auth.admin, {
      claimId: id,
      orderId: updatedClaim.order_id,
      approved: false,
      message: adminResponse,
    })

    return NextResponse.json({ claim: await getUpdatedClaim(updatedClaim) })
  }

  if (
    [
      "save_replacement_details",
      "approve_replacement_selection",
      "reject_replacement_selection",
      "mark_replacement_sent",
      "mark_replacement_resolved",
    ].includes(String(body.action ?? ""))
  ) {
    return NextResponse.json(
      { error: "El flujo de cambio de producto ya no está disponible." },
      { status: 410 },
    )
  }

  if (body.action === "mark_refund_done") {
    const { data: refundProof, error: proofError } = await auth.admin
      .from("order_claim_files")
      .select("id")
      .eq("claim_id", id)
      .eq("file_role", "comprobante_devolucion")
      .limit(1)

    if (proofError) {
      return NextResponse.json(
        { error: proofError.message || "No se pudo validar el comprobante." },
        { status: 500 },
      )
    }

    if (!refundProof?.length) {
      return NextResponse.json(
        { error: "Cargá el comprobante de devolución antes de marcar el reintegro como realizado." },
        { status: 409 },
      )
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const { data: updatedClaim, error: updateError } = await auth.admin
      .from("order_claims")
      .update({
        status: "cerrado",
        resolution: resolution || "reintegro_total",
        closed_at: nowIso,
        refund_completed_at: nowIso,
        refund_completed_by: auth.user.id,
        admin_needs_action: false,
      })
      .eq("id", id)
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .single()

    if (updateError || !updatedClaim) {
      return NextResponse.json(
        { error: updateError?.message || "No se pudo confirmar el reintegro." },
        { status: 500 },
      )
    }

    await auth.admin
      .from("ordenes")
      .update({
        order_change_status: "rejected",
        order_change_extra_amount: 0,
      })
      .eq("id", updatedClaim.order_id)

    await auth.admin.from("order_claim_messages").insert({
      claim_id: id,
      author_user_id: auth.user.id,
      author_role: auth.profile.rol,
      message: `BEYONIX realizó el reintegro el día ${new Intl.DateTimeFormat("es-AR").format(now)}.`,
    })

    const { data: finalClaim } = await auth.admin
      .from("order_claims")
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .eq("id", id)
      .single()

    return NextResponse.json({
      claim: await attachSignedUrls(auth.admin, finalClaim ?? updatedClaim),
    })
  }

  if (body.action === "save_replacement_details") {
    const replacementProduct =
      typeof body.replacement_product === "string"
        ? body.replacement_product.trim().slice(0, 240)
        : ""
    const replacementExtraCost = Number(body.replacement_extra_cost ?? 0)
    const replacementPaymentLink =
      typeof body.replacement_payment_link === "string"
        ? body.replacement_payment_link.trim().slice(0, 500)
        : ""
    const replacementShippingCompany =
      typeof body.replacement_shipping_company === "string"
        ? body.replacement_shipping_company.trim().slice(0, 160)
        : ""
    const replacementTracking =
      typeof body.replacement_tracking === "string"
        ? body.replacement_tracking.trim().slice(0, 180)
        : ""

    if (!replacementProduct) {
      return NextResponse.json(
        { error: "Indicá el producto de reemplazo." },
        { status: 400 },
      )
    }

    if (!Number.isFinite(replacementExtraCost) || replacementExtraCost < 0) {
      return NextResponse.json(
        { error: "Ingresá una diferencia válida. Usá 0 si no corresponde." },
        { status: 400 },
      )
    }

    const { data: currentClaim } = await auth.admin
      .from("order_claims")
      .select("status")
      .eq("id", id)
      .maybeSingle()

    const { data: updatedClaim, error: updateError } = await auth.admin
      .from("order_claims")
      .update({
        status:
          currentClaim?.status === "reemplazo_enviado"
            ? "reemplazo_enviado"
            : "cambio_pendiente",
        replacement_product: replacementProduct,
        replacement_extra_cost: Number.isFinite(replacementExtraCost)
          ? replacementExtraCost
          : 0,
        replacement_payment_link: replacementPaymentLink || null,
        replacement_shipping_company: replacementShippingCompany || null,
        replacement_tracking: replacementTracking || null,
        admin_needs_action: false,
      })
      .eq("id", id)
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .single()

    if (updateError || !updatedClaim) {
      return NextResponse.json(
        { error: updateError?.message || "No se pudo guardar el cambio." },
        { status: 500 },
      )
    }

    return NextResponse.json({ claim: await getUpdatedClaim(updatedClaim) })
  }

  if (body.action === "approve_replacement_selection") {
    const { data: currentClaim, error: currentClaimError } = await auth.admin
      .from("order_claims")
      .select("id, replacement_price_difference")
      .eq("id", id)
      .single()

    if (currentClaimError || !currentClaim) {
      return NextResponse.json(
        { error: currentClaimError?.message || "No encontramos el reclamo." },
        { status: 404 },
      )
    }

    if (Number(currentClaim.replacement_price_difference ?? 0) > 0) {
      const { data: differenceProof, error: proofError } = await auth.admin
        .from("order_claim_files")
        .select("id")
        .eq("claim_id", id)
        .eq("file_role", "comprobante_diferencia")
        .limit(1)

      if (proofError) {
        return NextResponse.json(
          { error: proofError.message || "No se pudo validar el comprobante de diferencia." },
          { status: 500 },
        )
      }

      if (!differenceProof?.length) {
        return NextResponse.json(
          { error: "Falta el comprobante de pago de la diferencia antes de aprobar el cambio." },
          { status: 409 },
        )
      }
    }

    const { data: updatedClaim, error: approveError } = await auth.admin
      .rpc("approve_order_claim_product_change", {
        p_claim_id: id,
        p_admin_id: auth.user.id,
      })

    if (approveError || !updatedClaim) {
      return NextResponse.json(
        { error: approveError?.message || "No se pudo aprobar el cambio." },
        { status: 500 },
      )
    }

    const priceDifference = Number((updatedClaim as any).replacement_price_difference ?? 0)
    if (priceDifference > 0) {
      await auth.admin
        .from("ordenes")
        .update({
          order_change_status: "change_approved",
          order_change_extra_amount: 0,
        })
        .eq("id", updatedClaim.order_id)
    }

    await auth.admin.from("order_claim_messages").insert({
      claim_id: id,
      author_user_id: auth.user.id,
      author_role: auth.profile.rol,
      message:
        priceDifference > 0
          ? "BEYONIX aprobó el cambio y el comprobante de la diferencia. Vamos a preparar el reemplazo."
          : "BEYONIX aprobó el cambio solicitado. Vamos a preparar el reemplazo.",
    })

    return NextResponse.json({ claim: await getUpdatedClaim(updatedClaim) })
  }

  if (body.action === "reject_replacement_selection") {
    if (adminResponse.length < 5) {
      return NextResponse.json(
        { error: "Escribí el motivo del rechazo para que el cliente lo vea claro." },
        { status: 400 },
      )
    }

    const { data: updatedClaim, error: updateError } = await auth.admin
      .from("order_claims")
      .update({
        status: "rechazado",
        resolution: "rechazado",
        rejection_reason: adminResponse,
        admin_response: adminResponse,
        closed_at: new Date().toISOString(),
        admin_needs_action: false,
      })
      .eq("id", id)
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .single()

    if (updateError || !updatedClaim) {
      return NextResponse.json(
        { error: updateError?.message || "No se pudo rechazar el cambio." },
        { status: 500 },
      )
    }

    await auth.admin
      .from("ordenes")
      .update({
        order_change_status: "rejected",
        order_change_extra_amount: 0,
      })
      .eq("id", updatedClaim.order_id)

    await auth.admin.from("order_claim_messages").insert({
      claim_id: id,
      author_user_id: auth.user.id,
      author_role: auth.profile.rol,
      message: adminResponse,
    })

    return NextResponse.json({ claim: await getUpdatedClaim(updatedClaim) })
  }

  if (body.action === "mark_replacement_sent") {
    const { data: currentClaim } = await auth.admin
      .from("order_claims")
      .select("resolution, replacement_product, replacement_shipping_company, replacement_tracking")
      .eq("id", id)
      .maybeSingle()

    const isMissingUnitResolution = currentClaim?.resolution === "envio_unidad_faltante"

    if (!currentClaim?.replacement_product) {
      return NextResponse.json(
        { error: isMissingUnitResolution ? "Guardá la unidad faltante antes de marcarla enviada." : "Guardá el producto de reemplazo antes de marcarlo enviado." },
        { status: 409 },
      )
    }

    if (!currentClaim.replacement_shipping_company) {
      return NextResponse.json(
        { error: isMissingUnitResolution ? "Indicá la empresa de envío antes de marcar la unidad faltante enviada." : "Indicá la empresa de envío antes de marcar el reemplazo enviado." },
        { status: 409 },
      )
    }

    if (!currentClaim.replacement_tracking) {
      return NextResponse.json(
        { error: isMissingUnitResolution ? "Indicá el número de seguimiento antes de marcar la unidad faltante enviada." : "Indicá el número de seguimiento antes de marcar el reemplazo enviado." },
        { status: 409 },
      )
    }

    const now = new Date()
    const { data: updatedClaim, error: updateError } = await auth.admin
      .from("order_claims")
      .update({
        status: "reemplazo_enviado",
        replacement_sent_at: now.toISOString(),
        admin_needs_action: false,
      })
      .eq("id", id)
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .single()

    if (updateError || !updatedClaim) {
      return NextResponse.json(
        { error: updateError?.message || (isMissingUnitResolution ? "No se pudo marcar la unidad faltante como enviada." : "No se pudo marcar el reemplazo como enviado.") },
        { status: 500 },
      )
    }

    const tracking = currentClaim.replacement_tracking
      ? ` Seguimiento: ${currentClaim.replacement_tracking}.`
      : ""
    await auth.admin.from("order_claim_messages").insert({
      claim_id: id,
      author_user_id: auth.user.id,
      author_role: auth.profile.rol,
      message: isMissingUnitResolution
        ? `BEYONIX despachó la unidad faltante.${tracking}`
        : `BEYONIX despachó el reemplazo.${tracking}`,
    })

    return NextResponse.json({ claim: await getUpdatedClaim(updatedClaim) })
  }

  if (body.action === "mark_replacement_resolved") {
    const nowIso = new Date().toISOString()
    const { data: updatedClaim, error: updateError } = await auth.admin
      .from("order_claims")
      .update({
        status: "cerrado",
        resolution: resolution || "cambio_producto",
        closed_at: nowIso,
        admin_needs_action: false,
      })
      .eq("id", id)
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .single()

    if (updateError || !updatedClaim) {
      return NextResponse.json(
        { error: updateError?.message || "No se pudo resolver el cambio." },
        { status: 500 },
      )
    }

    await auth.admin.from("order_claim_messages").insert({
      claim_id: id,
      author_user_id: auth.user.id,
      author_role: auth.profile.rol,
      message:
        resolution === "envio_unidad_faltante"
          ? "BEYONIX completó el envío de la unidad faltante."
          : "BEYONIX completó el cambio de producto.",
    })

    return NextResponse.json({ claim: await getUpdatedClaim(updatedClaim) })
  }

  if (body.action === "save_coupon") {
    const couponCode =
      typeof body.coupon_code === "string" ? body.coupon_code.trim().slice(0, 80) : ""

    if (!couponCode) {
      return NextResponse.json(
        { error: "Ingresá el código de cupón." },
        { status: 400 },
      )
    }

    const nowIso = new Date().toISOString()
    const { data: updatedClaim, error: updateError } = await auth.admin
      .from("order_claims")
      .update({
        status: "cerrado",
        resolution: resolution || "cupon_descuento",
        coupon_code: couponCode,
        coupon_created_at: nowIso,
        closed_at: nowIso,
        admin_needs_action: false,
      })
      .eq("id", id)
      .select("*, order_claim_files(*), order_claim_messages(*)")
      .single()

    if (updateError || !updatedClaim) {
      return NextResponse.json(
        { error: updateError?.message || "No se pudo guardar el cupón." },
        { status: 500 },
      )
    }

    await auth.admin.from("order_claim_messages").insert({
      claim_id: id,
      author_user_id: auth.user.id,
      author_role: auth.profile.rol,
      message: `BEYONIX generó tu cupón: ${couponCode}`,
    })

    return NextResponse.json({ claim: await getUpdatedClaim(updatedClaim) })
  }

  if (!ORDER_CLAIM_STATUSES.includes(status as any)) {
    return NextResponse.json({ error: "Estado inválido." }, { status: 400 })
  }

  if (resolution && !ORDER_CLAIM_RESOLUTIONS.includes(resolution as any)) {
    return NextResponse.json({ error: "Resolución inválida." }, { status: 400 })
  }

  const { data: currentClaim } = await auth.admin
    .from("order_claims")
    .select("admin_response, status, first_reviewed_at, failure_type, order_id, resolution, offered_resolutions")
    .eq("id", id)
    .maybeSingle()

  if (!currentClaim) {
    return NextResponse.json(
      { error: "No encontramos el reclamo." },
      { status: 404 },
    )
  }

  const effectiveResolution = resolution ?? currentClaim.resolution ?? null
  const effectiveOfferedResolutions =
    body.offered_resolutions === undefined
      ? currentClaim.offered_resolutions ?? []
      : offeredResolutions

  if (effectiveResolution === "cupon_descuento" && status === "cupon_pendiente") {
    if (!["admin", "super_admin"].includes(auth.profile.rol)) {
      return NextResponse.json(
        { error: "No tenés permisos para confirmar una nota de crédito." },
        { status: 403 },
      )
    }

    const { data: order } = await auth.admin
      .from("ordenes")
      .select("credit_note_issued, credit_note_status, credit_note_cae, credit_note_number")
      .eq("id", currentClaim.order_id)
      .maybeSingle()

    const creditNoteWasIssued =
      order?.credit_note_issued === true &&
      order.credit_note_status === "authorized" &&
      Boolean(order.credit_note_cae) &&
      Boolean(order.credit_note_number)

    if (!creditNoteWasIssued) {
      return NextResponse.json(
        {
          error:
            "La nota de crédito todavía no fue emitida y autorizada por ARCA.",
        },
        { status: 409 },
      )
    }
  }

  if (
    offeredResolutions.some(
      (item) =>
        !CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS.includes(item as any),
    )
  ) {
    return NextResponse.json(
      { error: "Hay soluciones ofrecidas inválidas." },
      { status: 400 },
    )
  }

  if (status === "rechazado" && !rejectionReason) {
    return NextResponse.json(
      { error: "Indicá el motivo de rechazo." },
      { status: 400 },
    )
  }

  if (status === "rechazado" && effectiveResolution !== "rechazado") {
    return NextResponse.json(
      { error: "Si rechazás el reclamo, la resolución debe ser Rechazado." },
      { status: 400 },
    )
  }

  if (status === "cerrado" && !effectiveResolution) {
    return NextResponse.json(
      { error: "Indicá la resolución antes de finalizar la conversación." },
      { status: 400 },
    )
  }

  if (
    effectiveResolution === "cupon_descuento" &&
    body.credit_note_amount !== undefined &&
    status !== "rechazado" &&
    (!Number.isFinite(creditNoteAmount) || Number(creditNoteAmount) <= 0)
  ) {
    return NextResponse.json(
      { error: "Indicá el monto real de la nota de crédito." },
      { status: 400 },
    )
  }

  if (
    effectiveResolution === "cupon_descuento" &&
    body.credit_note_amount !== undefined &&
    status !== "rechazado" &&
    Number.isFinite(creditNoteAmount) &&
    Number(creditNoteAmount) > 0
  ) {
    const remaining = await getRemainingCreditableAmount(
      auth.admin,
      currentClaim.order_id,
    )

    if (remaining === null) {
      return NextResponse.json(
        { error: "No se pudo validar el importe contra el pedido." },
        { status: 500 },
      )
    }

    if (Number(creditNoteAmount) > remaining + 0.005) {
      return NextResponse.json(
        {
          error: `El monto supera lo que el pedido todavía puede acreditar (máximo ${remaining.toFixed(2)}).`,
        },
        { status: 400 },
      )
    }
  }
  const helpMessage = currentClaim?.failure_type === "consulta_pedido"
  const shouldInsertAdminMessage =
    Boolean(adminResponse) &&
    (body.append_message === true ||
      adminResponse !== String(currentClaim?.admin_response ?? "").trim())

  const finalStatus = status === "rechazado" || status === "cerrado"
  const isFirstReview =
    currentClaim?.status === "recibido" &&
    status === "en_revision" &&
    !currentClaim.first_reviewed_at
  const clearsAdminAttention = shouldInsertAdminMessage || finalStatus || isFirstReview
  const nowIso = new Date().toISOString()
  const { data, error } = await auth.admin
    .from("order_claims")
    .update({
      status,
      admin_response: adminResponse || null,
      rejection_reason: rejectionReason || null,
      resolution: effectiveResolution,
      offered_resolutions: effectiveOfferedResolutions,
      closed_at: finalStatus ? nowIso : null,
      ...(clearsAdminAttention
        ? {
            admin_needs_action: false,
          }
        : {}),
      ...(shouldInsertAdminMessage
        ? {
            last_admin_response_at: nowIso,
          }
        : {}),
      ...(isFirstReview
        ? {
            first_reviewed_at: nowIso,
            first_reviewed_by: auth.user.id,
          }
        : {}),
    })
    .eq("id", id)
    .select("*, order_claim_files(*), order_claim_messages(*)")
    .single()

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message || "No se pudo actualizar el reclamo." },
      { status: 500 },
    )
  }

  if (
    effectiveResolution === "cupon_descuento" &&
    body.credit_note_amount !== undefined &&
    status !== "rechazado"
  ) {
    const creditNoteError = await markOrderCreditNoteRequired(
      auth.admin,
      Number(data.order_id),
      Number(creditNoteAmount),
    )

    if (creditNoteError) {
      return NextResponse.json(
        { error: creditNoteError.message || "No se pudo marcar la nota de crédito como pendiente." },
        { status: 500 },
      )
    }
  }

  if (shouldInsertAdminMessage) {
    await auth.admin.from("order_claim_messages").insert({
      claim_id: id,
      author_user_id: auth.user.id,
      author_role: auth.profile.rol,
      message: adminResponse,
    })

    await sendClaimUpdateEmail(auth.admin, {
      orderId: data.order_id,
      title: helpMessage && status === "cerrado"
        ? "Chat finalizado"
        : status === "cerrado"
          ? "Reclamo finalizado"
          : status === "rechazado"
            ? "Reclamo rechazado"
            : "Respuesta de BEYONIX",
      message: adminResponse,
    })
  } else if (finalStatus) {
    const title = helpMessage && status === "cerrado"
      ? "Chat finalizado"
      : status === "cerrado"
        ? "Reclamo finalizado"
        : "Reclamo rechazado"
    const message =
      helpMessage && status === "cerrado"
        ? "El chat de ayuda fue finalizado. Podés revisar el seguimiento desde tu cuenta."
        : status === "cerrado"
        ? "El reclamo fue finalizado. Podés revisar el seguimiento desde tu cuenta."
        : "El caso fue rechazado. Podés revisar el detalle desde tu cuenta."

    await notifyCustomer(auth.admin, {
      userId: data.user_id,
      type: status === "cerrado" ? "claim_resolved" : "claim_rejected",
      title,
      body: `${title} para el pedido ${getOrderCode(data.order_id)}.`,
      orderId: data.order_id,
      sourceKey: `claim:${id}:status:${status}`,
    })

    await sendClaimUpdateEmail(auth.admin, {
      orderId: data.order_id,
      title,
      message,
    })
  }

  const { data: updatedClaim } = await auth.admin
    .from("order_claims")
    .select("*, order_claim_files(*), order_claim_messages(*)")
    .eq("id", id)
    .single()

  return NextResponse.json({
    claim: await attachSignedUrls(auth.admin, updatedClaim ?? data),
  })
}
