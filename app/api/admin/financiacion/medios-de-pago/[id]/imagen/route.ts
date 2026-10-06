import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  buildPaymentLogoPath,
  PAYMENT_METHOD_LOGO_MAX_BYTES,
  PAYMENT_METHOD_LOGO_SELECT,
  PAYMENT_METHOD_LOGOS_BUCKET,
  validatePaymentLogoUpload,
  type PaymentMethodLogoRow,
} from "@/lib/payments/payment-method-logos"
import {
  loadAdminPaymentMethodsOverview,
  recordPaymentMethodAudit,
} from "@/lib/payments/payment-method-logos-server"

const MANAGE_ROLES = ["admin", "super_admin"] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Margen para el sobre multipart alrededor del archivo.
const MAX_REQUEST_BYTES = PAYMENT_METHOD_LOGO_MAX_BYTES + 64 * 1024

type RouteContext = { params: Promise<{ id: string }> }

async function loadRow(auth: Exclude<Awaited<ReturnType<typeof requireInternalUser>>, { error: Response }>, id: string) {
  const { data } = await auth.admin.from("payment_method_logos").select(PAYMENT_METHOD_LOGO_SELECT).eq("id", id).maybeSingle()
  return data as PaymentMethodLogoRow | null
}

/**
 * Subir o reemplazar el logo. Validación server-side de tipo, tamaño y bytes
 * reales (SVG sin scripts ni referencias externas). El archivo anterior se
 * borra recién después de guardar el nuevo.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { id } = await context.params
  if (!UUID_PATTERN.test(id)) return Response.json({ error: "Medio de pago inválido." }, { status: 400 })
  if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
    return Response.json({ error: "La imagen puede pesar hasta 1 MB." }, { status: 413 })
  }

  const row = await loadRow(auth, id)
  if (!row) return Response.json({ error: "Medio de pago no encontrado." }, { status: 404 })

  const form = await request.formData().catch(() => null)
  const file = form?.get("file")
  if (!(file instanceof File)) return Response.json({ error: "Elegí una imagen." }, { status: 400 })
  if (file.size > PAYMENT_METHOD_LOGO_MAX_BYTES) {
    return Response.json({ error: "La imagen puede pesar hasta 1 MB." }, { status: 413 })
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const validation = validatePaymentLogoUpload(bytes, file.type)
  if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 })

  const path = buildPaymentLogoPath(row.id, validation.format, Date.now())
  const storage = auth.admin.storage.from(PAYMENT_METHOD_LOGOS_BUCKET)
  const { error: uploadError } = await storage.upload(path, bytes, {
    contentType: validation.contentType,
    cacheControl: "31536000",
    upsert: false,
  })
  if (uploadError) return Response.json({ error: "No se pudo subir la imagen." }, { status: 500 })

  const { data, error } = await auth.admin
    .from("payment_method_logos")
    .update({ image_path: path, needs_review: false, updated_by: auth.user.id, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(PAYMENT_METHOD_LOGO_SELECT)
    .single()
  if (error || !data) {
    await storage.remove([path])
    return Response.json({ error: "No se pudo guardar la imagen." }, { status: 500 })
  }

  if (row.image_path && row.image_path !== path) {
    const { error: removeError } = await storage.remove([row.image_path])
    if (removeError) console.error("PAYMENT_METHOD_LOGO_REPLACE_CLEANUP_FAILED", { id })
  }
  await recordPaymentMethodAudit(auth, "UPDATE", id, row, data)
  return Response.json({ paymentMethods: await loadAdminPaymentMethodsOverview(auth.admin) })
}

/** Quitar el logo: el medio deja de mostrarse al cliente hasta cargar otro. */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { id } = await context.params
  if (!UUID_PATTERN.test(id)) return Response.json({ error: "Medio de pago inválido." }, { status: 400 })

  const row = await loadRow(auth, id)
  if (!row) return Response.json({ error: "Medio de pago no encontrado." }, { status: 404 })
  if (!row.image_path) return Response.json({ paymentMethods: await loadAdminPaymentMethodsOverview(auth.admin) })

  const { data, error } = await auth.admin
    .from("payment_method_logos")
    .update({ image_path: null, updated_by: auth.user.id, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(PAYMENT_METHOD_LOGO_SELECT)
    .single()
  if (error || !data) return Response.json({ error: "No se pudo quitar la imagen." }, { status: 500 })

  const { error: removeError } = await auth.admin.storage.from(PAYMENT_METHOD_LOGOS_BUCKET).remove([row.image_path])
  if (removeError) console.error("PAYMENT_METHOD_LOGO_REMOVE_FAILED", { id })
  await recordPaymentMethodAudit(auth, "UPDATE", id, row, data)
  return Response.json({ paymentMethods: await loadAdminPaymentMethodsOverview(auth.admin) })
}
