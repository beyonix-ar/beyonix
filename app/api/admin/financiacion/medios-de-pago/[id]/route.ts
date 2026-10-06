import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  normalizePaymentMethodName,
  PAYMENT_METHOD_LOGO_SELECT,
  PAYMENT_METHOD_LOGOS_BUCKET,
  type PaymentMethodLogoRow,
} from "@/lib/payments/payment-method-logos"
import {
  loadAdminPaymentMethodsOverview,
  recordPaymentMethodAudit,
} from "@/lib/payments/payment-method-logos-server"

const MANAGE_ROLES = ["admin", "super_admin"] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type RouteContext = { params: Promise<{ id: string }> }

/**
 * Activar/desactivar, renombrar un medio manual o marcar revisado un medio
 * nuevo. El estado de Mercado Pago (disponible/no disponible) nunca se edita
 * a mano: sólo lo cambia la sincronización.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { id } = await context.params
  if (!UUID_PATTERN.test(id)) return Response.json({ error: "Medio de pago inválido." }, { status: 400 })

  const body = (await request.json().catch(() => null)) as { enabled?: unknown; displayName?: unknown; reviewed?: unknown } | null
  if (!body) return Response.json({ error: "Solicitud inválida." }, { status: 400 })

  const { data: before } = await auth.admin.from("payment_method_logos").select(PAYMENT_METHOD_LOGO_SELECT).eq("id", id).maybeSingle()
  const row = before as PaymentMethodLogoRow | null
  if (!row) return Response.json({ error: "Medio de pago no encontrado." }, { status: 404 })

  const changes: Partial<Pick<PaymentMethodLogoRow, "enabled" | "display_name" | "needs_review">> = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return Response.json({ error: "Estado inválido." }, { status: 400 })
    changes.enabled = body.enabled
  }
  if (body.displayName !== undefined) {
    if (row.source !== "manual") {
      return Response.json({ error: "El nombre de un medio de Mercado Pago lo informa Mercado Pago." }, { status: 400 })
    }
    const displayName = normalizePaymentMethodName(body.displayName)
    if (!displayName) return Response.json({ error: "Ingresá un nombre de hasta 80 caracteres." }, { status: 400 })
    changes.display_name = displayName
  }
  if (body.reviewed === true) changes.needs_review = false
  if (Object.keys(changes).length === 0) return Response.json({ error: "No hay cambios para guardar." }, { status: 400 })

  const { data, error } = await auth.admin
    .from("payment_method_logos")
    .update({ ...changes, updated_by: auth.user.id, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(PAYMENT_METHOD_LOGO_SELECT)
    .single()
  if (error || !data) return Response.json({ error: "No se pudo guardar el medio de pago." }, { status: 500 })

  await recordPaymentMethodAudit(auth, "UPDATE", id, row, data)
  return Response.json({ paymentMethods: await loadAdminPaymentMethodsOverview(auth.admin) })
}

/** Sólo medios manuales: los de Mercado Pago nunca se borran (conservan su imagen). */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { id } = await context.params
  if (!UUID_PATTERN.test(id)) return Response.json({ error: "Medio de pago inválido." }, { status: 400 })

  const { data: before } = await auth.admin.from("payment_method_logos").select(PAYMENT_METHOD_LOGO_SELECT).eq("id", id).maybeSingle()
  const row = before as PaymentMethodLogoRow | null
  if (!row) return Response.json({ error: "Medio de pago no encontrado." }, { status: 404 })
  if (row.source !== "manual") {
    return Response.json({ error: "Los medios de Mercado Pago no se eliminan: se ocultan solos si dejan de estar disponibles." }, { status: 400 })
  }

  const { error } = await auth.admin.from("payment_method_logos").delete().eq("id", id).eq("source", "manual")
  if (error) return Response.json({ error: "No se pudo eliminar el medio de pago." }, { status: 500 })

  if (row.image_path) {
    const { error: storageError } = await auth.admin.storage.from(PAYMENT_METHOD_LOGOS_BUCKET).remove([row.image_path])
    if (storageError) console.error("PAYMENT_METHOD_LOGO_REMOVE_FAILED", { id })
  }
  await recordPaymentMethodAudit(auth, "DELETE", id, row, null)
  return Response.json({ paymentMethods: await loadAdminPaymentMethodsOverview(auth.admin) })
}
