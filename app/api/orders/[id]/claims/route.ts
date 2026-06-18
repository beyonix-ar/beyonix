import { NextResponse } from "next/server"

import {
  ACTIVE_ORDER_CLAIM_STATUSES,
  ORDER_CLAIM_BUCKET,
  getClaimFileValidationError,
  isClaimWindowOpen,
  sanitizeClaimFileName,
} from "@/lib/order-claims"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import type { OrderClaimType } from "@/lib/supabase/types"

const CLAIM_TYPES = ["transporte_48hs", "garantia_beyonix"]
const CONFIRMATION_KEYS = [
  "confirm_real_info",
  "confirm_kept_packaging",
  "confirm_no_misuse",
]

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

  if (order.estado !== "entregado") {
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

    if (claim.status !== "falta_informacion") {
      return NextResponse.json(
        { error: "Este reclamo no admite información adicional en este momento." },
        { status: 409 },
      )
    }

    if (message.length < 5 && files.length === 0) {
      return NextResponse.json(
        { error: "Agregá una respuesta o nueva evidencia." },
        { status: 400 },
      )
    }

    if (message.length >= 5) {
      await admin.from("order_claim_messages").insert({
        claim_id: claim.id,
        author_user_id: user.id,
        author_role: "cliente",
        message,
      })
    }

    await uploadFiles(admin, claim.id, user.id, files, fileRoles)
    await admin
      .from("order_claims")
      .update({ status: "en_revision" })
      .eq("id", claim.id)

    return getClaimResponse(admin, claim.id)
  }

  const claimType = String(formData.get("claimType") ?? "") as OrderClaimType
  const failureType = String(formData.get("failureType") ?? "").trim()
  const startedAt = String(formData.get("startedAt") ?? "").trim()

  if (!CLAIM_TYPES.includes(claimType)) {
    return NextResponse.json({ error: "Tipo de reclamo inválido." }, { status: 400 })
  }

  if (!isClaimWindowOpen(getDeliveryDate(order), claimType)) {
    return NextResponse.json(
      { error: "El plazo para este tipo de reclamo ya finalizó." },
      { status: 409 },
    )
  }

  for (const key of CONFIRMATION_KEYS) {
    if (formData.get(key) !== "true") {
      return NextResponse.json(
        { error: "Debés confirmar las declaraciones obligatorias." },
        { status: 400 },
      )
    }
  }

  if (description.length < 20) {
    return NextResponse.json(
      { error: "Describí el problema con al menos 20 caracteres." },
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

  const roleCounts = new Map<string, number>()
  fileRoles.forEach((role) => roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1))

  if (claimType === "transporte_48hs") {
    for (const role of ["embalaje_exterior", "producto_completo", "danio"]) {
      if (!roleCounts.get(role)) {
        return NextResponse.json(
          { error: "Faltan fotos obligatorias para el reclamo de entrega." },
          { status: 400 },
        )
      }
    }
  }

  if (claimType === "garantia_beyonix") {
    if (!failureType || !startedAt) {
      return NextResponse.json(
        { error: "Completá el tipo de falla y cuándo empezó." },
        { status: 400 },
      )
    }
    if (!roleCounts.get("video")) {
      return NextResponse.json(
        { error: "Para garantía por funcionamiento necesitamos un video." },
        { status: 400 },
      )
    }
  }

  const { data: claim, error: claimError } = await admin
    .from("order_claims")
    .insert({
      order_id: orderId,
      user_id: user.id,
      claim_type: claimType,
      status: "recibido",
      failure_type: failureType || null,
      started_at: startedAt || null,
      description,
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
