import "server-only"

import { createClient } from "@supabase/supabase-js"

import type { SupabaseProducto } from "@/lib/supabase/types"
import { hasPurchasableStock } from "@/lib/cart/stock-status"
import { attachStoreConditionedStock } from "@/lib/supabase/queries/store-conditioned"
import {
  applyAvailableStock,
  fetchActiveReservationTotals,
} from "@/lib/inventory/sellable-stock"

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
    .order("created_at", {
      ascending: false,
    })
    .limit(12)

  if (error) {
    throw error
  }

  if (!data?.length) {
    return null
  }

  const candidates = await attachStoreConditionedStock(
    supabase,
    data as unknown as FeaturedProductRow[],
  )
  // Visibilidad por stock físico (igual que el resto del catálogo); lo que
  // se muestra y se puede comprar es el DISPONIBLE (físico - reservas activas).
  const candidate = candidates.find(hasPurchasableStock)
  if (!candidate) return null
  const reservations = await fetchActiveReservationTotals(supabase, [candidate.id])
    .catch((error: unknown) => {
      console.error("STORE_STOCK_RESERVATIONS_LOAD_ERROR", error)
      return []
    })
  const [selected] = applyAvailableStock([candidate as FeaturedProductRow], reservations)

  const { reviews = [], ...product } = selected
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
