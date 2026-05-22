import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseProducto,
  SupabaseCategoria,
} from "@/lib/supabase/types"

// ─────────────────────────────────────────────────────────────────────────────
// Get productos
// ─────────────────────────────────────────────────────────────────────────────

export async function getStoreProductos() {
  const { data, error } =
    await supabase
      .from("productos")
      .select(`
        *,
        categorias(*)
      `)
      .eq("activo", true)
      .order("created_at", {
        ascending: false,
      })

  if (error) {
    throw error
  }

  return (data ??
    []) as SupabaseProducto[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Get destacados
// ─────────────────────────────────────────────────────────────────────────────

export async function getFeaturedProductos() {
  const { data, error } =
    await supabase
      .from("productos")
      .select(`
        *,
        categorias(*)
      `)
      .eq("activo", true)
      .eq("destacado", true)
      .order("created_at", {
        ascending: false,
      })
      .limit(12)

  if (error) {
    throw error
  }

  return (data ??
    []) as SupabaseProducto[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Get producto by slug
// ─────────────────────────────────────────────────────────────────────────────

export async function getProductoBySlug(
  slug: string
) {
  const { data, error } =
    await supabase
      .from("productos")
      .select(`
        *,
        categorias(*),
        imagenes_producto(*)
      `)
      .eq("slug", slug)
      .eq("activo", true)
      .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

// ─────────────────────────────────────────────────────────────────────────────
// Get productos by categoría
// ─────────────────────────────────────────────────────────────────────────────

export async function getProductosByCategoria(
  categoriaSlug: string
) {
  // Buscar categoría
  const {
    data: categoria,
    error: categoriaError,
  } = await supabase
    .from("categorias")
    .select("*")
    .eq("slug", categoriaSlug)
    .single()

  if (categoriaError) {
    throw categoriaError
  }

  // Buscar productos
  const { data, error } =
    await supabase
      .from("productos")
      .select(`
        *,
        categorias(*)
      `)
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

  return (data ??
    []) as SupabaseProducto[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Search productos
// ─────────────────────────────────────────────────────────────────────────────

export async function searchProductos(
  query: string
) {
  const { data, error } =
    await supabase
      .from("productos")
      .select(`
        *,
        categorias(*)
      `)
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

  return (data ??
    []) as SupabaseProducto[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Get categorías
// ─────────────────────────────────────────────────────────────────────────────

export async function getStoreCategorias() {
  const { data, error } =
    await supabase
      .from("categorias")
      .select("*")
      .order("nombre")

  if (error) {
    throw error
  }

  return (data ??
    []) as SupabaseCategoria[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Get related productos
// ─────────────────────────────────────────────────────────────────────────────

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
      .select(`
        *,
        categorias(*)
      `)
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

  return (data ??
    []) as SupabaseProducto[]
}