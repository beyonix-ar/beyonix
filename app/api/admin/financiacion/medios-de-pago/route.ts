import { requireInternalUser } from "@/lib/auth/admin-api"
import { normalizePaymentMethodName, PAYMENT_METHOD_LOGO_SELECT } from "@/lib/payments/payment-method-logos"
import {
  loadAdminPaymentMethodsOverview,
  recordPaymentMethodAudit,
} from "@/lib/payments/payment-method-logos-server"

const MANAGE_ROLES = ["admin", "super_admin"] as const

/** Admin → Financiación → "MEDIOS DE PAGO DISPONIBLES": estado guardado (sin consultar Mercado Pago). */
export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  try {
    return Response.json({ paymentMethods: await loadAdminPaymentMethodsOverview(auth.admin) })
  } catch {
    return Response.json({ error: "No se pudieron cargar los medios de pago." }, { status: 500 })
  }
}

/** Alta de un medio manual / externo: nace deshabilitado y sin imagen. */
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as { displayName?: unknown } | null
  const displayName = normalizePaymentMethodName(body?.displayName)
  if (!displayName) {
    return Response.json({ error: "Ingresá un nombre de hasta 80 caracteres." }, { status: 400 })
  }

  const { data, error } = await auth.admin
    .from("payment_method_logos")
    .insert({ source: "manual", display_name: displayName, enabled: false, updated_by: auth.user.id })
    .select(PAYMENT_METHOD_LOGO_SELECT)
    .single()
  if (error || !data) {
    return Response.json({ error: "No se pudo crear el medio de pago." }, { status: 500 })
  }

  await recordPaymentMethodAudit(auth, "INSERT", data.id, null, data)
  return Response.json({ paymentMethods: await loadAdminPaymentMethodsOverview(auth.admin) })
}
