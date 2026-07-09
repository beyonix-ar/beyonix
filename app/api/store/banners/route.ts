import { createClient } from "@/lib/supabase/server"

const LEGACY_BANNER_KEY = "products_hero"
const ALLOWED_PLACEMENTS = new Set(["products"])

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const placement =
    searchParams.get("placement")?.trim() ||
    (searchParams.get("key")?.trim() === LEGACY_BANNER_KEY ? "products" : "")

  if (!ALLOWED_PLACEMENTS.has(placement)) {
    return Response.json({ banners: [], banner: null }, { status: 404 })
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("site_banner_items")
    .select("id, placement, image_url, alt_text, active, sort_order, updated_at")
    .eq("placement", placement)
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })

  if (!error && data?.length) {
    return Response.json({ banners: data, banner: data[0] })
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
