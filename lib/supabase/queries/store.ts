import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseCategoria,
  SupabaseProducto,
} from "@/lib/supabase/types"
import { hasPurchasableStock } from "@/lib/cart/stock-status"
import { attachProductReviewSummaries } from "@/lib/reviews/product-review-summary"
import { attachStoreConditionedStock } from "@/lib/supabase/queries/store-conditioned"
import {
  applyAvailableStock,
  fetchActiveReservationTotals,
} from "@/lib/inventory/sellable-stock"

/**
 * Stock condicionado + stock DISPONIBLE (físico - reservas activas) en una
 * sola pasada, con ambas lecturas en paralelo y una consulta por lote (sin
 * N+1). La visibilidad del producto (`hasPurchasableStock`) sigue dependiendo
 * del stock FÍSICO: un producto totalmente reservado se muestra como agotado
 * en vez de desaparecer, y vuelve a estar disponible cuando la reserva vence.
 */
export async function prepareStoreProducts(
  products: SupabaseProducto[],
  options: { onlyWithStock?: boolean; excludeSessionId?: string | null } = {},
) {
  const [withConditioned, reservations] = await Promise.all([
    attachStoreConditionedStock(supabase, products),
    fetchActiveReservationTotals(
      supabase,
      products.map((product) => product.id),
      { excludeSessionId: options.excludeSessionId },
    ).catch((error: unknown) => {
      // Sólo orientación para la UI: sin reservas se muestra el físico y
      // reserve_cart_stock sigue rechazando lo que no esté disponible.
      console.error("STORE_STOCK_RESERVATIONS_LOAD_ERROR", error)
      return []
    }),
  ])
  const visible = options.onlyWithStock
    ? withConditioned.filter(hasPurchasableStock)
    : withConditioned
  return applyAvailableStock(visible, reservations)
}

const PRODUCT_SELECT = `
  *,
  categorias(*),
  imagenes_producto(*),
  producto_variantes(*),
  producto_especificaciones(*)
`

export async function getStoreProductos(
  options?: { limit?: number }
) {
  let query = supabase
    .from("productos")
    .select(PRODUCT_SELECT)
    .eq("activo", true)
    .order("created_at", {
      ascending: false,
    })

  if (options?.limit) {
    query = query.limit(options.limit)
  }

  const { data, error } = await query

  if (error) {
    throw error
  }

  const products = await prepareStoreProducts(
    (data || []) as SupabaseProducto[],
    { onlyWithStock: true },
  )

  return attachProductReviewSummaries(products)
}

const CART_PRODUCT_SELECT = `
  *,
  imagenes_producto(*),
  producto_variantes(*)
`

/**
 * Catálogo vigente de los productos del carrito (precio, variantes, stock,
 * cuotas y stock condicionado) para refrescar carrito/checkout abiertos.
 * Sólo productos activos: uno desactivado no vuelve y se quita del carrito.
 */
export async function getStoreCartProducts(
  productIds: number[],
  options: { excludeSessionId?: string | null } = {},
) {
  const ids = [...new Set(productIds.filter((id) => Number.isFinite(id)))]
  if (!ids.length) return []

  const { data, error } = await supabase
    .from("productos")
    .select(CART_PRODUCT_SELECT)
    .in("id", ids)
    .eq("activo", true)

  if (error) {
    throw error
  }

  // Sin descontar la reserva de la propia sesión (Paso 3 vigente).
  return prepareStoreProducts((data || []) as SupabaseProducto[], {
    excludeSessionId: options.excludeSessionId,
  })
}

export async function getFeaturedProductos() {
  const { data, error } =
    await supabase
      .from("productos")
      .select(PRODUCT_SELECT)
      .eq("activo", true)
      .eq("destacado", true)
      .order("created_at", {
        ascending: false,
      })
      .limit(12)

  if (error) {
    throw error
  }

  const products = await prepareStoreProducts(
    (data || []) as SupabaseProducto[],
    { onlyWithStock: true },
  )

  return attachProductReviewSummaries(products)
}

export async function getProductoBySlug(
  slug: string
) {
  const { data, error } =
    await supabase
      .from("productos")
      .select(PRODUCT_SELECT)
      .eq("slug", slug)
      .eq("activo", true)
      .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) return null

  // Ninguna de las dos depende del resultado de la otra: sólo necesitan el
  // producto base recién leído, así que se piden en paralelo en vez de
  // encadenar dos round-trips secuenciales en la página de producto.
  const [[conditionedProduct], [reviewProduct]] = await Promise.all([
    prepareStoreProducts([data as SupabaseProducto], { onlyWithStock: true }),
    attachProductReviewSummaries([data as SupabaseProducto]),
  ])

  if (!conditionedProduct) {
    return null
  }

  return reviewProduct
    ? {
        ...conditionedProduct,
        average_rating: reviewProduct.average_rating,
        reviews_count: reviewProduct.reviews_count,
      }
    : conditionedProduct
}

export async function getProductosByCategoria(
  categoriaSlug: string
) {
  const {
    data: categoria,
    error: categoriaError,
  } = await supabase
    .from("categorias")
    .select("id")
    .eq("slug", categoriaSlug)
    .maybeSingle()

  if (categoriaError) {
    throw categoriaError
  }

  if (!categoria) {
    return []
  }

  return getProductosByCategoriaId(categoria.id)
}

export async function getProductosByCategoriaId(
  categoriaId: number
) {
  const { data, error } =
    await supabase
      .from("productos")
      .select(PRODUCT_SELECT)
      .eq(
        "categoria_id",
        categoriaId
      )
      .eq("activo", true)
      .order("created_at", {
        ascending: false,
      })

  if (error) {
    throw error
  }

  const products = await prepareStoreProducts(
    (data || []) as SupabaseProducto[],
    { onlyWithStock: true },
  )

  return attachProductReviewSummaries(products)
}

export async function searchProductos(
  query: string
) {
  const { data, error } =
    await supabase
      .from("productos")
      .select(PRODUCT_SELECT)
      .eq("activo", true)
      .ilike(
        "nombre",
        `%${query}%`
      )
      .order("created_at", {
        ascending: false,
      })

  if (error) {
    throw error
  }

  const products = await prepareStoreProducts(
    (data || []) as SupabaseProducto[],
    { onlyWithStock: true },
  )

  return attachProductReviewSummaries(products)
}

export async function getStoreCategorias() {
  const { data, error } =
    await supabase
      .from("categorias")
      .select("*")
      .order("nombre")

  if (error) {
    throw error
  }

  return (
    data || []
  ).filter((categoria) => {
    const activeValue = (
      categoria as SupabaseCategoria & {
        activo?: boolean | null
      }
    ).activo

    return activeValue !== false
  }) as SupabaseCategoria[]
}

export async function getRelatedProductos(
  productoId: number,
  categoriaId?: number | null
) {
  if (!categoriaId) {
    return []
  }

  const { data, error } =
    await supabase
      .from("productos")
      .select(PRODUCT_SELECT)
      .eq("activo", true)
      .eq(
        "categoria_id",
        categoriaId
      )
      .neq("id", productoId)
      .limit(8)

  if (error) {
    throw error
  }

  const products = await prepareStoreProducts(
    (data || []) as SupabaseProducto[],
    { onlyWithStock: true },
  )

  return attachProductReviewSummaries(products)
}
