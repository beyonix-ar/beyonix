import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import {
  CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS,
  ORDER_CLAIM_BUCKET,
  ORDER_CLAIM_RESOLUTIONS,
  ORDER_CLAIM_STATUSES,
} from "@/lib/order-claims"

function stripBucket(path: string) {
  return path.startsWith(`${ORDER_CLAIM_BUCKET}/`)
    ? path.slice(ORDER_CLAIM_BUCKET.length + 1)
    : path
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

  const body = (await request.json()) as {
    status?: unknown
    admin_response?: unknown
    rejection_reason?: unknown
    resolution?: unknown
    offered_resolutions?: unknown
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
    .select("admin_response")
    .eq("id", id)
    .maybeSingle()
  const shouldInsertAdminMessage =
    Boolean(adminResponse) &&
    adminResponse !== String(currentClaim?.admin_response ?? "").trim()

  const finalStatus = status === "rechazado" || status === "cerrado"
  const { data, error } = await auth.admin
    .from("order_claims")
    .update({
      status,
      admin_response: adminResponse || null,
      rejection_reason: rejectionReason || null,
      resolution,
      offered_resolutions: offeredResolutions,
      closed_at: finalStatus ? new Date().toISOString() : null,
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
