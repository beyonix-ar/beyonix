import { NextResponse } from "next/server"

import { normalizeAndreaniError } from "@/lib/andreani/client"
import { runAndreaniTrackingSyncBatch } from "@/lib/andreani/tracking-sync-batch"
import { createAdminClient } from "@/lib/supabase/admin"

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const authorization = request.headers.get("authorization")

  if (cronSecret && authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const startedAt = Date.now()
  console.info("ANDREANI_TRACKING_SYNC_BATCH_STARTED", { startedAt: new Date(startedAt).toISOString() })

  try {
    const result = await runAndreaniTrackingSyncBatch(createAdminClient())
    const durationMs = Date.now() - startedAt
    console.info("ANDREANI_TRACKING_SYNC_BATCH_FINISHED", {
      ...result,
      unchanged: result.updated - result.statusChanged,
      durationMs,
    })
    return NextResponse.json({ ok: true, ...result, durationMs })
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    const durationMs = Date.now() - startedAt
    console.error("ANDREANI_TRACKING_SYNC_BATCH_ERROR", { ...safeError, durationMs })
    return NextResponse.json({ ok: false, error: safeError.message }, { status: 502 })
  }
}
