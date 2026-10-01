import { requireInternalUser } from "@/lib/auth/admin-api"
import { syncMercadoPagoInterestFreeReference } from "@/lib/mercadopago/interest-free-sync"
import { getMercadoPagoCostsOverview } from "@/lib/site-settings"

const MANAGE_ROLES = ["admin", "super_admin"] as const

// Consultas secuenciales a Mercado Pago (escalera de montos + búsqueda binaria por cuota).
export const maxDuration = 60

/**
 * "Comprobar ahora": consulta FRESCA a Mercado Pago (sin caché) y guarda la
 * referencia. Si Mercado Pago no responde de forma confiable se registra el
 * fallo (hora y mensaje) y la tienda deja de comunicar la promoción hasta la
 * próxima sincronización exitosa.
 */
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const result = await syncMercadoPagoInterestFreeReference(auth.admin, { updatedBy: auth.user.id })
  const mercadoPagoCosts = await getMercadoPagoCostsOverview()
  if (!result.ok) {
    return Response.json({ error: result.error, mercadoPagoCosts }, { status: 502 })
  }
  return Response.json({ mercadoPagoCosts })
}
