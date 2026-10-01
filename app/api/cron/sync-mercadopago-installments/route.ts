import { NextResponse } from "next/server"

import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { syncMercadoPagoInterestFreeReference } from "@/lib/mercadopago/interest-free-sync"
import { getSiteSettings } from "@/lib/site-settings"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Sincronización periódica de las cuotas sin interés que confirma Mercado
 * Pago. En producción (VPS + PM2) la dispara el timer de systemd
 * `deploy/systemd/beyonix-sync-mercadopago-installments.timer` por loopback;
 * no hay cron de Vercel. Con cuotas sin interés desactivadas en Admin →
 * Financiación no consulta nada: no hay promoción que comunicar.
 */
export async function GET(request: Request) {
  // Falla cerrado: sin CRON_SECRET configurado nadie puede gastar la cuota
  // de consultas a Mercado Pago desde afuera.
  if (!isCronRequestAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const { interestFreePolicy } = await getSiteSettings({ fresh: true })
  if (!interestFreePolicy.enabled) {
    return NextResponse.json({ ok: true, skipped: "interest_free_disabled" })
  }

  const result = await syncMercadoPagoInterestFreeReference(createAdminClient())
  return NextResponse.json(
    { ok: result.ok, error: result.error ?? null, checkedAt: result.status.reference?.checkedAt ?? null },
    { status: result.ok ? 200 : 502 },
  )
}
