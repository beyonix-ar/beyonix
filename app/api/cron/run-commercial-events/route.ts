import { NextResponse } from "next/server"

import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { runDueCommercialEvents } from "@/lib/commercial-events/runner"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Ejecuta los eventos programados vencidos (Admin → Eventos): restaura los
 * que terminan y aplica los que empiezan. En producción (VPS + PM2) lo
 * dispara cada minuto `deploy/systemd/beyonix-run-commercial-events.timer`
 * por loopback; no hay cron de Vercel. Idempotente: dos corridas seguidas no
 * duplican cambios.
 */
export async function GET(request: Request) {
  if (!isCronRequestAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const result = await runDueCommercialEvents(createAdminClient())
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 500 })
  const failed = result.processed.filter((item) => !item.ok).length
  // 502 si algún evento falló: el servicio de systemd queda "failed" y se ve en journalctl.
  return NextResponse.json({ ok: failed === 0, processed: result.processed }, { status: failed ? 502 : 200 })
}
