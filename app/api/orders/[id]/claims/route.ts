import { NextResponse } from "next/server"

import {
  ACTIVE_ORDER_CLAIM_STATUSES,
  ORDER_CLAIM_BUCKET,
  getClaimFileValidationError,
  isClaimWindowOpen,
  sanitizeClaimFileName,
} from "@/lib/order-claims"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import type { OrderClaimType } from "@/lib/supabase/types"

const CLAIM_TYPES = ["transporte_48hs", "garantia_beyonix"]
const CANCELLATION_PROBLEM_TYPE = "cancelar_compra"
const HELP_MESSAGE_PROBLEM_TYPE = "consulta_pedido"
const POST_DELIVERY_PROBLEM_TYPES = [
  "danado",
  "incorrecto",
  "falla",
  "faltante",
  "cantidad_menor",
  "otro",
]
const BLOCKED_CHANGE_PROBLEM_TYPES = [
  "cambio_producto",
  "cambio_color",
  "cambio_cantidad",
  "modificar_envio",
  "otro_pre_despacho",
  "devolucion",
  "no_llego",
]

type OrderState = {
  id: number
  usuario_id: string | null
  cliente_email?: string | null
  cliente_nombre?: string | null
  estado?: string | null
  tracking_number?: string | null
  andreani_tracking?: string | null
  andreani_envio_id?: string | null
  andreani_estado?: string | null
  delivered_at?: string | null
  created_at: string
  invoice_status?: string | null
  invoice_cae?: string | null
  invoice_number?: number | null
  invoice_point?: number | null
}

function isOrderDelivered(order: OrderState) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return (
    estado === "entregado" ||
    Boolean(order.delivered_at) ||
    andreaniStatus.includes("entregado")
  )
}

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

function getDeliveryDate(order: OrderState) {
  return order.delivered_at || order.created_at
}

function hasReplacementPayload(formData: FormData) {
  return [
    "replacementItems",
    "replacementProductId",
    "replacementVariantId",
    "replacementQuantity",
    "replacementOriginalProduct",
    "replacementOriginalVariant",
    "replacementOriginalPrice",
    "replacementChangeReason",
  ].some((key) => formData.has(key))
}

function validateFiles(files: File[]) {
  return files.map((file) => getClaimFileValidationError(file)).find(Boolean) ?? ""
}

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
}

async function createCustomerNotification(
  admin: ReturnType<typeof createAdminClient>,
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

async function notifyCustomerCaseCreated(
  admin: ReturnType<typeof createAdminClient>,
  order: OrderState,
  claim: { id: number; failure_type?: string | null },
) {
  const orderCode = getOrderCode(order.id)
  const helpMessage = claim.failure_type === HELP_MESSAGE_PROBLEM_TYPE

  const title = helpMessage ? "Mensaje de ayuda recibido" : "Reclamo iniciado"
  const body = helpMessage
    ? `Recibimos tu mensaje de ayuda por el pedido ${orderCode}.`
    : `Recibimos tu reclamo por el pedido ${orderCode}.`
  const subject = helpMessage
    ? `Recibimos tu mensaje de ayuda ${orderCode}`
    : `Recibimos tu reclamo ${orderCode}`
  const heading = helpMessage ? "Mensaje de ayuda recibido" : "Reclamo iniciado"
  const emailBody = helpMessage
    ? `Hola ${order.cliente_nombre ?? ""}, recibimos tu mensaje de ayuda por el pedido ${orderCode}.`
    : `Hola ${order.cliente_nombre ?? ""}, recibimos tu reclamo por el pedido ${orderCode}.`
  const emailDetail = helpMessage
    ? "BEYONIX revisará tu consulta y te avisará las novedades en tu cuenta y por email."
    : "BEYONIX revisará el caso y te avisará las novedades en tu cuenta y por email."

  await createCustomerNotification(admin, {
    userId: order.usuario_id,
    type: helpMessage ? "help_message_started" : "claim_started",
    title,
    body,
    orderId: order.id,
    sourceKey: `claim:${claim.id}:created`,
  })

  await sendOrderStatusEmail({
    to: order.cliente_email,
    subject,
    html: `
        <h1>${heading}</h1>
        <p>${emailBody}</p>
        <p>${emailDetail}</p>
      `,
  })
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
      { error: "No se pudieron cargar los casos de ayuda." },
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

  if (hasReplacementPayload(formData)) {
    return NextResponse.json(
      { error: "No es posible modificar productos, variantes o cantidades desde Ayuda con tu compra." },
      { status: 400 },
    )
  }

  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("id, usuario_id, cliente_email, cliente_nombre, estado, delivered_at, created_at, tracking_number, andreani_tracking, andreani_envio_id, andreani_estado, invoice_status, invoice_cae, invoice_number, invoice_point")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id !== user.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  const claimId = Number(formData.get("claimId"))
  const description = String(formData.get("description") ?? "").trim()
  const message = String(formData.get("message") ?? "").trim()
  const files = formData.getAll("files").filter((file): file is File => file instanceof File)
  const fileRoles = formData.getAll("fileRoles").map((role) => String(role))
  const fileError = validateFiles(files)

  if (fileError) {
    return NextResponse.json({ error: fileError }, { status: 400 })
  }

  if (fileRoles.some((role) => role === "comprobante_diferencia")) {
    return NextResponse.json(
      { error: "Este flujo ya no admite comprobantes por diferencia de cambio." },
      { status: 400 },
    )
  }

  if (claimId) {
    const { data: claim, error: claimError } = await admin
      .from("order_claims")
      .select("*")
      .eq("id", claimId)
      .eq("order_id", orderId)
      .eq("user_id", user.id)
      .maybeSingle()

    if (claimError || !claim) {
      return NextResponse.json({ error: "No encontramos el caso." }, { status: 404 })
    }

    if (!ACTIVE_ORDER_CLAIM_STATUSES.includes(claim.status as any)) {
      return NextResponse.json(
        { error: "Este caso ya no admite respuestas." },
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
  const problemType = String(formData.get("problemType") ?? "").trim()
  const startedAt = String(formData.get("startedAt") ?? "").trim()
  const affectedItemIds = String(formData.get("affectedItemIds") ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
  const delivered = isOrderDelivered(order)
  const cancelled = (order.estado ?? "").toLowerCase() === "cancelado"
  const helpMessage = problemType === HELP_MESSAGE_PROBLEM_TYPE

  if (!CLAIM_TYPES.includes(claimType)) {
    return NextResponse.json({ error: "Tipo de caso inválido." }, { status: 400 })
  }

  if (BLOCKED_CHANGE_PROBLEM_TYPES.includes(problemType)) {
    return NextResponse.json(
      { error: "Ayuda con tu compra no permite modificar productos, cantidades ni datos del pedido." },
      { status: 400 },
    )
  }

  if (!helpMessage && problemType !== CANCELLATION_PROBLEM_TYPE && !POST_DELIVERY_PROBLEM_TYPES.includes(problemType)) {
    return NextResponse.json({ error: "Motivo de reclamo inválido." }, { status: 400 })
  }

  if (problemType === CANCELLATION_PROBLEM_TYPE) {
    return NextResponse.json(
      { error: "La cancelación de compra se procesa automáticamente desde el flujo de cancelación." },
      { status: 410 },
    )
  }

  if (helpMessage && cancelled) {
    return NextResponse.json(
      { error: "La compra figura como cancelada. Revisá el seguimiento de cancelación desde el detalle del pedido." },
      { status: 409 },
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
      { error: "Ya existe una solicitud activa para este pedido." },
      { status: 409 },
    )
  }

  if (!helpMessage) {
    const existingFormalClaimResult = await admin
      .from("order_claims")
      .select("id")
      .eq("order_id", orderId)
      .not("failure_type", "in", "(cancelar_compra,consulta_pedido)")
      .limit(1)

    if (existingFormalClaimResult.error) {
      return NextResponse.json(
        { error: "No pudimos validar los reclamos previos del pedido." },
        { status: 500 },
      )
    }

    if ((existingFormalClaimResult.data ?? []).length > 0) {
      return NextResponse.json(
        {
          error:
            "Este pedido ya tiene un reclamo finalizado o en curso. Si necesitás contactarnos, escribinos a beyonix.ar@gmail.com.",
        },
        { status: 409 },
      )
    }
  }

  if (helpMessage && delivered) {
    return NextResponse.json(
      { error: "El pedido ya figura como entregado. Podés iniciar un reclamo si tuviste un problema con la compra recibida." },
      { status: 409 },
    )
  }

  if (!delivered && !helpMessage) {
    return NextResponse.json(
      { error: "Todavía no podés iniciar un reclamo porque el pedido no figura como entregado." },
      { status: 409 },
    )
  }

  if (!helpMessage && !isClaimWindowOpen(getDeliveryDate(order), claimType)) {
    return NextResponse.json(
      { error: "El plazo para este tipo de reclamo ya finalizó." },
      { status: 409 },
    )
  }

  if (description.length < 10) {
    return NextResponse.json(
      { error: "Contanos un poco más para poder ayudarte." },
      { status: 400 },
    )
  }

  if (affectedItemIds.length > 0) {
    const { count, error: itemError } = await admin
      .from("orden_items")
      .select("id", { count: "exact", head: true })
      .eq("orden_id", orderId)
      .in("id", affectedItemIds)

    if (itemError || (count ?? 0) !== affectedItemIds.length) {
      return NextResponse.json(
        { error: "El producto seleccionado no pertenece al pedido." },
        { status: 400 },
      )
    }
  }

  const now = new Date().toISOString()
  const safeDescription = description
  const { data: claim, error: claimError } = await admin
    .from("order_claims")
    .insert({
      order_id: orderId,
      user_id: user.id,
      claim_type: claimType,
      status: "recibido",
      failure_type: problemType,
      started_at: startedAt || null,
      description: safeDescription,
      offered_resolutions: [],
      admin_needs_action: true,
      last_customer_message_at: now,
    })
    .select()
    .single()

  if (claimError || !claim) {
    return NextResponse.json(
      { error: claimError?.message || "No se pudo crear la solicitud." },
      { status: 500 },
    )
  }

  await admin.from("order_claim_messages").insert({
    claim_id: claim.id,
    author_user_id: user.id,
    author_role: "cliente",
    message: safeDescription,
  })

  try {
    await uploadFiles(admin, claim.id, user.id, files, fileRoles)
  } catch (uploadError) {
    return NextResponse.json(
      { error: uploadError instanceof Error ? uploadError.message : "No se pudo guardar la evidencia." },
      { status: 500 },
    )
  }

  await notifyCustomerCaseCreated(admin, order, claim)

  return getClaimResponse(admin, claim.id)
}

export async function PATCH() {
  return NextResponse.json(
    { error: "BEYONIX definirá la resolución del caso desde el panel administrativo." },
    { status: 410 },
  )
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

    const { error: insertError } = await admin.from("order_claim_files").insert({
      claim_id: claimId,
      uploaded_by: userId,
      file_role: fileRoles[index] || "evidencia_adicional",
      file_name: file.name,
      file_path: normalizeStoredPath(path),
      mime_type: file.type || "application/octet-stream",
      file_size: file.size,
    })

    if (insertError) throw new Error(insertError.message || "No se pudo guardar la evidencia.")
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
      { error: "No se pudo cargar el caso actualizado." },
      { status: 500 },
    )
  }

  const [claim] = await attachSignedUrls(admin, claims)
  return NextResponse.json({ claim })
}
