import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import {
  loadLocalDeliveryEffectsSummary,
  localDeliveryServiceDeps,
  whereLocalDeliveryEligible,
} from "@/lib/orders/local-delivery-deps"
import { recoverLocalDeliveryEffects } from "@/lib/orders/local-delivery-service"
import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Entregados hace más que esto ya no se reintentan solos (siguen visibles y con reintento manual). */
const RECOVERY_WINDOW_DAYS = 30
const CANDIDATE_LIMIT = 200
/** Pedidos procesados por corrida: los emails salen de a uno. */
const MAX_RECOVERIES_PER_RUN = 50

/**
 * Envío BEYONIX: completa solos los efectos que quedaron pendientes al pasar a
 * En camino o Entregado (historial, garantía, email). Usa la misma lógica
 * canónica y el mismo candado por pedido que Despachos y el cadete: un efecto
 * nunca se completa dos veces y un email nunca sale dos veces. Lo que agota
 * los reintentos automáticos queda pendiente y visible en Despachos.
 */
export async function GET(request: Request) {
  if (!isCronRequestAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "No autorizado." }, { status: 401 })
  }
  const admin = createAdminClient()
  const since = new Date(Date.now() - RECOVERY_WINDOW_DAYS * 86_400_000).toISOString()
  const query = admin.from("ordenes").select("id,estado,delivered_at")
  const candidates = await whereLocalDeliveryEligible<typeof query>(query)
    .in("estado", ["en_camino", "entregado"])
    .or(`delivered_at.is.null,delivered_at.gte.${since}`)
    .order("id", { ascending: false })
    .limit(CANDIDATE_LIMIT)
  if (candidates.error) {
    console.error("LOCAL_DELIVERY_EFFECTS_RECOVERY_FAILED", { stage: "candidates", code: candidates.error.code })
    return Response.json({ ok: false, error: "No se pudieron leer las entregas locales." }, { status: 503 })
  }
  const orders = (candidates.data ?? []) as Array<{ id: number; estado: string | null; delivered_at: string | null }>

  let summaries: Awaited<ReturnType<typeof loadLocalDeliveryEffectsSummary>>
  try {
    summaries = await loadLocalDeliveryEffectsSummary(admin, orders)
  } catch {
    console.error("LOCAL_DELIVERY_EFFECTS_RECOVERY_FAILED", { stage: "effects" })
    return Response.json({ ok: false, error: "No se pudieron leer los efectos pendientes." }, { status: 503 })
  }
  // Sólo pedidos con algún efecto pendiente que todavía se intenta solo.
  const retryable = orders
    .filter((order) => {
      const summary = summaries.get(order.id)
      return summary !== undefined && summary.pending.length > summary.exhausted.length
    })
    .slice(0, MAX_RECOVERIES_PER_RUN)

  const deps = localDeliveryServiceDeps(admin, { type: "system" })
  let completed = 0
  let stillPending = 0
  let skipped = 0
  let errors = 0
  for (const order of retryable) {
    try {
      const result = await recoverLocalDeliveryEffects(deps, order.id)
      if (result.status !== 200) skipped += 1
      else if (result.body.pendingEffects?.length) stillPending += 1
      else completed += 1
    } catch {
      errors += 1
    }
  }
  const summary = { checked: orders.length, attempted: retryable.length, completed, stillPending, skipped, errors }
  if (retryable.length) console.log("LOCAL_DELIVERY_EFFECTS_RECOVERY", summary)
  return Response.json({ ok: errors === 0, ...summary })
}
