import { NextResponse } from "next/server"

import { runClaimShipmentTrackingBatch } from "@/lib/andreani/claim-shipments"
import { normalizeAndreaniError } from "@/lib/andreani/client"
import { isAndreaniTrackingCronAuthorized } from "@/lib/andreani/tracking-sync-cron-auth"
import { runAndreaniTrackingSyncBatch } from "@/lib/andreani/tracking-sync-batch"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * El timer de la VPS corta la llamada a los 120 s (curl --max-time). Pasado
 * este presupuesto no se empieza ningún envío más: lo pendiente queda para el
 * próximo tick, nunca a medio procesar cuando curl ya abandonó la respuesta.
 */
const PEDIDOS_TIME_BUDGET_MS = 60_000
const CLAIM_SHIPMENTS_TIME_BUDGET_MS = 95_000

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const authorization = request.headers.get("authorization")

  if (!isAndreaniTrackingCronAuthorized(authorization, cronSecret)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const startedAt = Date.now()
  console.info("ANDREANI_TRACKING_SYNC_BATCH_STARTED", { startedAt: new Date(startedAt).toISOString() })

  try {
    const admin = createAdminClient()
    const result = await runAndreaniTrackingSyncBatch(admin, { deadlineMs: startedAt + PEDIDOS_TIME_BUDGET_MS })
    // Envíos de reclamos (devolución y reemplazo): mismo cron, sin tocar el
    // resultado del batch de pedidos si fallara.
    const claimShipments = await runClaimShipmentTrackingBatch(admin, {
      deadlineMs: startedAt + CLAIM_SHIPMENTS_TIME_BUDGET_MS,
    }).catch((error: unknown) => {
      console.error("ANDREANI_CLAIM_SHIPMENT_BATCH_ERROR", normalizeAndreaniError(error))
      return null
    })
    const durationMs = Date.now() - startedAt
    console.info("ANDREANI_TRACKING_SYNC_BATCH_FINISHED", {
      ...result,
      unchanged: result.updated - result.statusChanged,
      claimShipments,
      durationMs,
    })
    return NextResponse.json({ ok: true, ...result, claimShipments, durationMs })
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    const durationMs = Date.now() - startedAt
    console.error("ANDREANI_TRACKING_SYNC_BATCH_ERROR", { ...safeError, durationMs })
    return NextResponse.json({ ok: false, error: safeError.message }, { status: 502 })
  }
}
