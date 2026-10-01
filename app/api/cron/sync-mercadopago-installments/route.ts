import { NextResponse } from "next/server"

import { syncMercadoPagoInterestFreeReference } from "@/lib/mercadopago/interest-free-sync"
import { getSiteSettings } from "@/lib/site-settings"
import { createAdminClient } from "@/lib/supabase/admin"

// Consultas secuenciales a Mercado Pago (escalera de montos + búsqueda binaria por cuota).
export const maxDuration = 60

/**
 * Sincronización periódica de las cuotas sin interés que confirma Mercado
 * Pago (ver vercel.json). Con cuotas sin interés desactivadas en Admin →
 * Financiación no consulta nada: no hay promoción que comunicar.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const authorization = request.headers.get("authorization")

  if (!cronSecret) {
    return NextResponse.json(
      { error: "La tarea programada no está configurada." },
      { status: 503 },
    )
  }

  if (authorization !== `Bearer ${cronSecret}`) {
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
