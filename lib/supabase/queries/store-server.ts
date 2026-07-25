import "server-only"

import { createClient } from "@supabase/supabase-js"

import type { SupabaseProducto } from "@/lib/supabase/types"

const FEATURED_PRODUCT_SELECT = `
  *,
  categorias(*),
  imagenes_producto(*),
  producto_variantes(*),
  producto_especificaciones(*),
  reviews(rating)
`

type FeaturedProductRow = SupabaseProducto & {
  reviews?: Array<{
    rating: number | null
  }>
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
)

export async function getFeaturedProduct() {
  const { data, error } = await supabase
    .from("productos")
    .select(FEATURED_PRODUCT_SELECT)
    .eq("activo", true)
    .eq("destacado", true)
    .gt("stock", 0)
    .order("created_at", {
      ascending: false,
    })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) {
    return null
  }

  const { reviews = [], ...product } = data as unknown as FeaturedProductRow
  const ratings = reviews
    .map((review) => Number(review.rating))
    .filter((rating) => Number.isFinite(rating) && rating >= 1 && rating <= 5)

  return {
    ...product,
    average_rating:
      ratings.length > 0
        ? ratings.reduce((total, rating) => total + rating, 0) / ratings.length
        : null,
    reviews_count: ratings.length,
  } satisfies SupabaseProducto
}
