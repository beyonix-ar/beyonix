import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
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

async function attachSignedUrls(admin: any, claim: any) {
  return {
    ...claim,
    order_claim_files: await Promise.all(
      (claim.order_claim_files ?? []).map(async (file: any) => {
        const { data } = await admin.storage
          .from(ORDER_CLAIM_BUCKET)
          .createSignedUrl(stripBucket(file.file_path), 300)

        return {
          ...file,
          signedUrl: data?.signedUrl ?? null,
        }
      }),
    ),
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

  if (!ORDER_CLAIM_STATUSES.includes(status as any)) {
    return NextResponse.json({ error: "Estado inválido." }, { status: 400 })
  }

  if (resolution && !ORDER_CLAIM_RESOLUTIONS.includes(resolution as any)) {
    return NextResponse.json({ error: "Resolución inválida." }, { status: 400 })
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

  if (status === "rechazado" && resolution !== "rechazado") {
    return NextResponse.json(
      { error: "Si rechazás el reclamo, la resolución debe ser Rechazado." },
      { status: 400 },
    )
  }

  if (status === "cerrado" && !resolution) {
    return NextResponse.json(
      { error: "Indicá la resolución antes de finalizar la conversación." },
      { status: 400 },
    )
  }

  const { data: currentClaim } = await auth.admin
    .from("order_claims")
    .select("admin_response, status, first_reviewed_at")
    .eq("id", id)
    .maybeSingle()
  const shouldInsertAdminMessage =
    Boolean(adminResponse) &&
    (body.append_message === true ||
      adminResponse !== String(currentClaim?.admin_response ?? "").trim())

  const finalStatus = status === "rechazado" || status === "cerrado"
  const isFirstReview =
    currentClaim?.status === "recibido" &&
    status === "en_revision" &&
    !currentClaim.first_reviewed_at
  const { data, error } = await auth.admin
    .from("order_claims")
    .update({
      status,
      admin_response: adminResponse || null,
      rejection_reason: rejectionReason || null,
      resolution,
      offered_resolutions: offeredResolutions,
      closed_at: finalStatus ? new Date().toISOString() : null,
      ...(isFirstReview
        ? {
            first_reviewed_at: new Date().toISOString(),
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

  if (shouldInsertAdminMessage) {
    await auth.admin.from("order_claim_messages").insert({
      claim_id: id,
      author_user_id: auth.user.id,
      author_role: auth.profile.rol,
      message: adminResponse,
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
