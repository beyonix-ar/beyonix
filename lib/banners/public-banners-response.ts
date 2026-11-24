import type { SupabaseClient } from "@supabase/supabase-js"

import { loadPublicBanners, toHomeCampaignState, type PublicBannersResult } from "@/lib/banners/public-banners"

const LEGACY_BANNER_KEY = "products_hero"
const ALLOWED_PLACEMENTS = new Set(["products", "home"] as const)

type Placement = "products" | "home"

const isPlacement = (value: string): value is Placement => ALLOWED_PLACEMENTS.has(value as Placement)

/**
 * GET /api/store/banners. Productos conserva su contrato ({ banners, banner });
 * Home devuelve sólo la campaña vigente de mayor prioridad, el próximo cambio
 * previsto (sólo la hora) y la hora del servidor, sin caché.
 */
export async function publicBannersResponse(request: Request, getClient: () => Promise<SupabaseClient>) {
  const { searchParams } = new URL(request.url)
  const placement =
    searchParams.get("placement")?.trim() ||
    (searchParams.get("key")?.trim() === LEGACY_BANNER_KEY ? "products" : "")

  if (!isPlacement(placement)) {
    return Response.json({ banners: [], banner: null }, { status: 404 })
  }

  const supabase = await getClient()
  let result: PublicBannersResult | null = null
  try {
    // Vigencia [inicio, fin) resuelta en la base: nunca se exponen campañas futuras ni desactivadas.
    result = await loadPublicBanners(supabase, placement)
  } catch {
    result = null
  }

  if (placement === "home") {
    // Sin lectura confiable no se muestra ninguna campaña (ni una vieja como respaldo).
    const state = result ? toHomeCampaignState(result) : { banner: null, nextChangeAt: null, serverNow: new Date().toISOString() }
    return Response.json(state, { status: result ? 200 : 503, headers: { "Cache-Control": "no-store" } })
  }

  if (result?.banners.length) {
    return Response.json({ banners: result.banners, banner: result.banners[0] })
  }

  // Respaldo heredado (site_banners) SÓLO si Productos nunca tuvo banners
  // propios: si los tiene pero ninguno está vigente o activo, o si la lectura
  // falló, no reaparece un banner antiguo.
  if (!result || result.hasItems) {
    return Response.json({ banners: [], banner: null })
  }

  const fallback = await supabase
    .from("site_banners")
    .select("key, title, image_url, alt_text, active, updated_at")
    .eq("key", LEGACY_BANNER_KEY)
    .eq("active", true)
    .maybeSingle()

  const fallbackBanner =
    fallback.data?.image_url
      ? {
          id: fallback.data.key,
          placement,
          image_url: fallback.data.image_url,
          alt_text: fallback.data.alt_text,
          active: fallback.data.active,
          sort_order: 0,
          updated_at: fallback.data.updated_at,
        }
      : null

  return Response.json({
    banners: fallbackBanner ? [fallbackBanner] : [],
    banner: fallbackBanner,
  })
}
