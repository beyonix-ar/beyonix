import { createAdminClient } from "@/lib/supabase/admin"
import type { PublicPaymentMethodLogo } from "@/lib/payments/payment-method-logos"
import { loadPublicPaymentMethodLogos } from "@/lib/payments/payment-method-logos-server"

// Lectura pública de lo ya sincronizado: nunca consulta Mercado Pago (eso
// sólo ocurre desde Admin) y sólo expone logos visibles, sin estados internos.
const CACHE_TTL_MS = 60_000
let cache: { expiresAt: number; logos: PublicPaymentMethodLogo[] } | null = null

export async function GET() {
  const now = Date.now()
  if (!cache || cache.expiresAt <= now) {
    try {
      cache = { expiresAt: now + CACHE_TTL_MS, logos: await loadPublicPaymentMethodLogos(createAdminClient()) }
    } catch {
      return Response.json({ error: "No disponible." }, { status: 503, headers: { "Cache-Control": "no-store" } })
    }
  }
  return Response.json(
    { logos: cache.logos },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" } },
  )
}
