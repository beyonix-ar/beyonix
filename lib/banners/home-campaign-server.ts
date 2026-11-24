import "server-only"

import { createClient } from "@supabase/supabase-js"

import { loadPublicBanners, toHomeCampaignState, type HomeCampaignState } from "@/lib/banners/public-banners"

/**
 * Campaña del HOME para el render del servidor. Sin cookies: no fuerza el
 * render dinámico (hoy el HOME ya se renderiza en cada request por el nonce
 * CSP del layout; si volviera a ser ISR, el cliente confirma la campaña).
 * Si Supabase falla, el HOME sigue sin campaña: nunca se usa un respaldo que
 * pueda mostrar una campaña vencida o futura.
 */
export async function getHomeCampaign(): Promise<HomeCampaignState> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  try {
    if (!url || !anonKey) throw new Error("SUPABASE_NOT_CONFIGURED")
    const supabase = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
    return toHomeCampaignState(await loadPublicBanners(supabase, "home"))
  } catch (error) {
    console.error("Error cargando la campaña del Home:", error instanceof Error ? error.message : error)
    return { banner: null, nextChangeAt: null, serverNow: new Date().toISOString() }
  }
}
