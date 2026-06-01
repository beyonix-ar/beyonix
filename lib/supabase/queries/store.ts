import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseCategoria,
  SupabaseProducto,
} from "@/lib/supabase/types"

const PRODUCT_SELECT = `
  *,
  categorias(*),
  imagenes_producto(*),
  producto_variantes(*),
  producto_especificaciones(*)
`

export async function getStoreProductos() {
  const { data, error } =
    await supabase
      .from("productos")
      .select(PRODUCT_SELECT)
      .eq("activo", true)
      .order("created_at", {
        ascending: false,
      })

  if (error) {
    throw error
  }

  return (data ||
    []) as SupabaseProducto[]
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

  return (data ||
    []) as SupabaseProducto[]
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
      .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
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

  return (data ||
    []) as SupabaseProducto[]
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

  return (data ||
    []) as SupabaseProducto[]
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

  return (data ||
    []) as SupabaseProducto[]
}
