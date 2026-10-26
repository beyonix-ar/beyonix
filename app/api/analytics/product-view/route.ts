import { isInternalRole, isUserRole } from "@/lib/auth/roles"
import { getTrustedClientIp } from "@/lib/auth/trusted-client-ip"
import {
  getAnalyticsClientKey,
  getDeviceType,
  isAutomatedUserAgent,
  parseProductViewPayload,
} from "@/lib/analytics/product-view-event"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Beacon `product_view` de la tienda. Público (los visitantes anónimos
 * también cuentan), pero:
 * - el usuario sale del token verificado, nunca del payload;
 * - el producto se valida en la base (existe y está activo);
 * - deduplicación y límites viven en `record_product_view` (server-side);
 * - la respuesta es siempre 204 vacío salvo payload inválido, así no se
 *   filtra si una vista contó, se descartó o falló. Analítica nunca devuelve
 *   un error que el cliente tenga que manejar.
 */

const NO_CONTENT = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } })

type AdminClient = ReturnType<typeof createAdminClient>

/** Usuario autenticado verificado, o `null`. Un token inválido no rechaza la vista: la vuelve anónima. */
async function resolveViewer(admin: AdminClient, request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
  if (!token) return { userId: null, internal: false }

  const { data, error } = await admin.auth.getClaims(token)
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : null
  if (error || !userId) return { userId: null, internal: false }

  const { data: profile } = await admin.from("profiles").select("rol").eq("id", userId).maybeSingle()
  const role = profile?.rol
  return { userId, internal: isUserRole(role) && isInternalRole(role) }
}

export async function POST(request: Request) {
  const payload = parseProductViewPayload(await request.text().catch(() => ""))
  if (!payload) {
    return Response.json({ error: "Evento inválido." }, { status: 400 })
  }

  const userAgent = request.headers.get("user-agent")
  if (isAutomatedUserAgent(userAgent)) return NO_CONTENT()

  try {
    const admin = createAdminClient()
    const viewer = await resolveViewer(admin, request)
    // La navegación del equipo (Admin, operadores) no es demanda de clientes.
    if (viewer.internal) return NO_CONTENT()

    const { error } = await admin.rpc("record_product_view", {
      p_session_id: payload.sessionId,
      p_product_id: payload.productId,
      p_user_id: viewer.userId,
      p_source: payload.source,
      p_device_type: getDeviceType(userAgent),
      p_client_key: getAnalyticsClientKey(getTrustedClientIp(request)),
    })
    if (error) console.warn("[analytics] product_view no registrada", { code: error.code })
  } catch (error) {
    console.warn("[analytics] product_view no registrada", {
      message: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    })
  }

  return NO_CONTENT()
}
