import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  loadAdminPaymentMethodsOverview,
  syncPaymentMethodLogos,
} from "@/lib/payments/payment-method-logos-server"

const MANAGE_ROLES = ["admin", "super_admin"] as const

/**
 * "Actualizar desde Mercado Pago": consulta GET /v1/payment_methods con el
 * token del servidor. Si falla, el último estado conocido queda intacto y se
 * informa el motivo junto con ese estado.
 */
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  try {
    const result = await syncPaymentMethodLogos(auth.admin, { updatedBy: auth.user.id })
    const paymentMethods = await loadAdminPaymentMethodsOverview(auth.admin)
    if (!result.ok) return Response.json({ error: result.error, paymentMethods }, { status: 502 })
    return Response.json({ paymentMethods, summary: result.summary })
  } catch {
    return Response.json({ error: "No se pudo sincronizar con Mercado Pago." }, { status: 500 })
  }
}
