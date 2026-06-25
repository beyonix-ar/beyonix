import { NextResponse } from "next/server"

import {
  ACTIVE_ORDER_CLAIM_STATUSES,
  CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS,
  ORDER_CLAIM_BUCKET,
  getClaimFileValidationError,
  getOrderClaimResolutionLabel,
  isClaimWindowOpen,
  sanitizeClaimFileName,
} from "@/lib/order-claims"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import type { OrderClaimType } from "@/lib/supabase/types"

const CLAIM_TYPES = ["transporte_48hs", "garantia_beyonix"]
const PROBLEM_TYPES = ["danado", "incorrecto", "falla", "devolucion", "no_llego", "otro"]

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

function getDeliveryDate(order: { delivered_at?: string | null; created_at: string }) {
  return order.delivered_at || order.created_at
}

async function attachSignedUrls(
  admin: ReturnType<typeof createAdminClient>,
  claims: any[],
) {
  return Promise.all(
    claims.map(async (claim) => ({
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
    })),
  )
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("id, usuario_id")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id !== user.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  const { data: claims, error } = await admin
    .from("order_claims")
    .select("*, order_claim_files(*), order_claim_messages(*)")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })

  if (error) {
    return NextResponse.json(
      { error: "No se pudieron cargar los reclamos." },
      { status: 500 },
    )
  }

  return NextResponse.json({ claims: await attachSignedUrls(admin, claims ?? []) })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const formData = await request.formData()
  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("id, usuario_id, estado, delivered_at, created_at")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id !== user.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  const isMissingDeliveryClaim =
    String(formData.get("problemType") ?? "") === "no_llego"

  if (order.estado !== "entregado" && !isMissingDeliveryClaim) {
    return NextResponse.json(
      { error: "El pedido debe estar entregado para iniciar un reclamo." },
      { status: 409 },
    )
  }

  const claimId = Number(formData.get("claimId"))
  const description = String(formData.get("description") ?? "").trim()
  const message = String(formData.get("message") ?? "").trim()
  const files = formData.getAll("files").filter((file): file is File => file instanceof File)
  const fileRoles = formData.getAll("fileRoles").map((role) => String(role))

  if (claimId) {
    const { data: claim, error: claimError } = await admin
      .from("order_claims")
      .select("*")
      .eq("id", claimId)
      .eq("order_id", orderId)
      .eq("user_id", user.id)
      .maybeSingle()

    if (claimError || !claim) {
      return NextResponse.json({ error: "No encontramos el reclamo." }, { status: 404 })
    }

    if (!ACTIVE_ORDER_CLAIM_STATUSES.includes(claim.status as any)) {
      return NextResponse.json(
        { error: "Este reclamo ya no admite respuestas." },
        { status: 409 },
      )
    }

    const refundAccountHolder = String(formData.get("refundAccountHolder") ?? "").trim()
    const refundAccountIdentifier = String(formData.get("refundAccountIdentifier") ?? "").trim()
    const refundBank = String(formData.get("refundBank") ?? "").trim()
    const refundAmountConfirmed = String(formData.get("refundAmountConfirmed") ?? "").trim()
    const isRefundDetailsSubmission =
      Boolean(refundAccountHolder || refundAccountIdentifier || refundBank || refundAmountConfirmed)

    if (claim.status === "reintegro_pendiente") {
      if (!isRefundDetailsSubmission) {
        return NextResponse.json(
          { error: "Completá los datos de reintegro para continuar." },
          { status: 409 },
        )
      }

      if (
        !refundAccountHolder ||
        !refundAccountIdentifier ||
        !refundBank ||
        !refundAmountConfirmed
      ) {
        return NextResponse.json(
          { error: "Completá todos los datos de reintegro." },
          { status: 400 },
        )
      }

      const now = new Date().toISOString()
      const { error: refundError } = await admin
        .from("order_claims")
        .update({
          refund_account_holder: refundAccountHolder.slice(0, 180),
          refund_account_identifier: refundAccountIdentifier.slice(0, 180),
          refund_bank: refundBank.slice(0, 180),
          refund_amount_confirmed: refundAmountConfirmed.slice(0, 80),
          refund_details_submitted_at: now,
          admin_needs_action: true,
          last_customer_message_at: now,
        })
        .eq("id", claim.id)

      if (refundError) {
        return NextResponse.json(
          { error: "No se pudieron guardar los datos de reintegro." },
          { status: 500 },
        )
      }

      await admin.from("order_claim_messages").insert({
        claim_id: claim.id,
        author_user_id: user.id,
        author_role: "cliente",
        message: "Datos de reintegro enviados. BEYONIX realizará el reintegro.",
      })

      return getClaimResponse(admin, claim.id)
    }

    const { data: latestMessage } = await admin
      .from("order_claim_messages")
      .select("author_role")
      .eq("claim_id", claim.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (latestMessage?.author_role === "cliente") {
      return NextResponse.json(
        { error: "Mensaje enviado. Esperá la respuesta de BEYONIX para continuar." },
        { status: 409 },
      )
    }

    if (message.length < 5 && files.length === 0) {
      return NextResponse.json(
        { error: "Agregá una respuesta o nueva evidencia." },
        { status: 400 },
      )
    }

    if (files.length > 0 && claim.status !== "falta_informacion") {
      const { count } = await admin
        .from("order_claim_files")
        .select("id", { count: "exact", head: true })
        .eq("claim_id", claim.id)

      if ((count ?? 0) > 0) {
        return NextResponse.json(
          { error: "La evidencia ya fue enviada. Podrás adjuntar más archivos si BEYONIX solicita información adicional." },
          { status: 409 },
        )
      }
    }

    if (message.length >= 5) {
      await admin.from("order_claim_messages").insert({
        claim_id: claim.id,
        author_user_id: user.id,
        author_role: "cliente",
        message,
      })
    } else if (files.length > 0) {
      await admin.from("order_claim_messages").insert({
        claim_id: claim.id,
        author_user_id: user.id,
        author_role: "cliente",
        message: "El cliente adjuntó nueva evidencia.",
      })
    }

    await uploadFiles(admin, claim.id, user.id, files, fileRoles)
    await admin
      .from("order_claims")
      .update({
        status: "en_revision",
        admin_needs_action: true,
        last_customer_message_at: new Date().toISOString(),
      })
      .eq("id", claim.id)

    return getClaimResponse(admin, claim.id)
  }

  const claimType = String(formData.get("claimType") ?? "") as OrderClaimType
  const failureType = String(formData.get("failureType") ?? "").trim()
  const problemType = String(formData.get("problemType") ?? "").trim()
  const startedAt = String(formData.get("startedAt") ?? "").trim()

  if (!CLAIM_TYPES.includes(claimType)) {
    return NextResponse.json({ error: "Tipo de reclamo inválido." }, { status: 400 })
  }

  if (
    problemType !== "no_llego" &&
    !isClaimWindowOpen(getDeliveryDate(order), claimType)
  ) {
    return NextResponse.json(
      { error: "El plazo para este tipo de reclamo ya finalizó." },
      { status: 409 },
    )
  }

  if (problemType && !PROBLEM_TYPES.includes(problemType)) {
    return NextResponse.json({ error: "Motivo de reclamo inválido." }, { status: 400 })
  }

  if (description.length < 10) {
    return NextResponse.json(
      { error: "Contanos un poco más para poder ayudarte." },
      { status: 400 },
    )
  }

  const activeClaimResult = await admin
    .from("order_claims")
    .select("id")
    .eq("order_id", orderId)
    .in("status", ACTIVE_ORDER_CLAIM_STATUSES)
    .maybeSingle()

  if (activeClaimResult.data) {
    return NextResponse.json(
      { error: "Ya existe un reclamo activo para este pedido." },
      { status: 409 },
    )
  }

  const { data: claim, error: claimError } = await admin
    .from("order_claims")
    .insert({
      order_id: orderId,
      user_id: user.id,
      claim_type: claimType,
      status: "recibido",
      failure_type: problemType || failureType || null,
      started_at: startedAt || null,
      description,
      admin_needs_action: true,
      last_customer_message_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (claimError || !claim) {
    return NextResponse.json(
      { error: claimError?.message || "No se pudo crear el reclamo." },
      { status: 500 },
    )
  }

  await admin.from("order_claim_messages").insert({
    claim_id: claim.id,
    author_user_id: user.id,
    author_role: "cliente",
    message: description,
  })

  await uploadFiles(admin, claim.id, user.id, files, fileRoles)
  return getClaimResponse(admin, claim.id)
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const body = (await request.json()) as {
    claimId?: unknown
    selectedResolution?: unknown
    decision?: unknown
  }
  const claimId = Number(body.claimId)
  const selectedResolution = String(body.selectedResolution ?? "")
  const decision = body.decision === "reject" ? "reject" : "accept"

  if (!Number.isFinite(claimId) || claimId <= 0) {
    return NextResponse.json({ error: "Reclamo inválido." }, { status: 400 })
  }

  if (
    decision === "accept" &&
    !CUSTOMER_SELECTABLE_ORDER_CLAIM_RESOLUTIONS.includes(
      selectedResolution as any,
    )
  ) {
    return NextResponse.json({ error: "Solución inválida." }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: claim, error: claimError } = await admin
    .from("order_claims")
    .select("*")
    .eq("id", claimId)
    .eq("order_id", orderId)
    .eq("user_id", user.id)
    .maybeSingle()

  if (claimError || !claim) {
    return NextResponse.json(
      { error: "No encontramos el reclamo." },
      { status: 404 },
    )
  }

  if (
    !["recibido", "en_revision", "falta_informacion", "aprobado"].includes(
      claim.status,
    )
  ) {
    return NextResponse.json(
      { error: "Este reclamo ya no admite selección de solución." },
      { status: 409 },
    )
  }

  if (
    decision === "accept" &&
    !(claim.offered_resolutions ?? []).includes(selectedResolution)
  ) {
    return NextResponse.json(
      { error: "Esta solución no está disponible para tu reclamo." },
      { status: 409 },
    )
  }

  const accepted = decision === "accept"
  const refundAccepted =
    accepted &&
    (selectedResolution === "reintegro_total" ||
      selectedResolution === "reintegro_parcial")
  const { error } = await admin
    .from("order_claims")
    .update({
      customer_selected_resolution: accepted ? selectedResolution : null,
      resolution: accepted ? selectedResolution : null,
      offered_resolutions: accepted ? claim.offered_resolutions ?? [] : [],
      status: accepted
        ? refundAccepted
          ? "reintegro_pendiente"
          : "cerrado"
        : "en_revision",
      closed_at: accepted && !refundAccepted ? new Date().toISOString() : null,
      admin_needs_action: false,
    })
    .eq("id", claim.id)

  if (error) {
    return NextResponse.json(
      { error: "No se pudo guardar la solución elegida." },
      { status: 500 },
    )
  }
  const historyMessage = accepted
    ? refundAccepted
      ? `El cliente aceptó la solución: ${getOrderClaimResolutionLabel(selectedResolution)}. Quedan pendientes los datos para realizar el reintegro.`
      : `El cliente aceptó la solución: ${getOrderClaimResolutionLabel(selectedResolution)}.`
    : "El cliente rechazó la solución ofrecida. El reclamo volvió a revisión."

  await admin.from("order_claim_messages").insert({
    claim_id: claim.id,
    author_user_id: user.id,
    author_role: "cliente",
    message: historyMessage,
  })

  return getClaimResponse(admin, claim.id)
}

async function uploadFiles(
  admin: ReturnType<typeof createAdminClient>,
  claimId: number,
  userId: string,
  files: File[],
  fileRoles: string[],
) {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    const validationError = getClaimFileValidationError(file)

    if (validationError) throw new Error(validationError)

    const safeName = sanitizeClaimFileName(file.name)
    const path = `${claimId}/${Date.now()}-${index}-${safeName}`
    const { error } = await admin.storage.from(ORDER_CLAIM_BUCKET).upload(path, file, {
      contentType: file.type,
      upsert: false,
    })

    if (error) throw new Error(error.message || "No se pudo subir la evidencia.")

    await admin.from("order_claim_files").insert({
      claim_id: claimId,
      uploaded_by: userId,
      file_role: fileRoles[index] || "evidencia_adicional",
      file_name: file.name,
      file_path: normalizeStoredPath(path),
      mime_type: file.type || "application/octet-stream",
      file_size: file.size,
    })
  }
}

async function getClaimResponse(
  admin: ReturnType<typeof createAdminClient>,
  claimId: number,
) {
  const { data: claims, error } = await admin
    .from("order_claims")
    .select("*, order_claim_files(*), order_claim_messages(*)")
    .eq("id", claimId)

  if (error || !claims?.[0]) {
    return NextResponse.json(
      { error: "No se pudo cargar el reclamo actualizado." },
      { status: 500 },
    )
  }

  const [claim] = await attachSignedUrls(admin, claims)
  return NextResponse.json({ claim })
}
