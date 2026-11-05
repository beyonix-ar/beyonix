import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const BATCH_SIZE = 100
const MAX_BATCHES = 10

/**
 * Envío BEYONIX: vence las reservas de pedidos devueltos a BEYONIX cuyo plazo
 * terminó (00:00 hora de BEYONIX) y devuelve esas unidades al stock vendible.
 * La RPC es idempotente y segura con dos ejecuciones simultáneas (SKIP LOCKED
 * por pedido y revalidación bajo lock); no depende de que nadie abra Admin.
 */
export async function GET(request: Request) {
  if (!isCronRequestAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "No autorizado." }, { status: 401 })
  }
  const admin = createAdminClient()
  let expired = 0
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { data, error } = await admin.rpc("expire_local_delivery_return_reservations", { p_limit: BATCH_SIZE })
    if (error) {
      console.error("LOCAL_DELIVERY_RESERVATION_EXPIRY_FAILED", { code: error.code })
      return Response.json({ ok: false, expired, error: "No se pudieron vencer las reservas." }, { status: 503 })
    }
    const count = Number((data as { expired?: unknown } | null)?.expired ?? 0)
    expired += count
    if (count < BATCH_SIZE) break
  }
  return Response.json({ ok: true, expired })
}
