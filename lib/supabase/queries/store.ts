import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseCategoria,
  SupabaseProducto,
} from "@/lib/supabase/types"

const PRODUCT_SELECT = `
  *,
  categorias(*),
  imagenes_producto(*),
  producto_variantes(*)
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
    .single()

  if (categoriaError) {
    throw categoriaError
  }

  const { data, error } =
    await supabase
      .from("productos")
      .select(PRODUCT_SELECT)
      .eq(
        "categoria_id",
        categoria.id
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

  return (data ||
    []) as SupabaseCategoria[]
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
