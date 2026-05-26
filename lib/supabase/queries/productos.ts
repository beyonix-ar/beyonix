import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseCategoria,
  SupabaseProducto,
} from "@/lib/supabase/types"

interface ProductoPayload {
  nombre: string
  slug: string
  descripcion?: string | null
  precio: number
  precio_anterior?: number | null
  descuento?: number | null
  stock?: number
  categoria_id?: number | null
  destacado?: boolean
  activo?: boolean
}

const PRODUCTO_SELECT = `
  *,
  categorias(*),
  imagenes_producto(*)
`

// ─────────────────────────────────────────────────────────────
// Productos
// ─────────────────────────────────────────────────────────────

export async function getProductos() {
  const { data, error } = await supabase
    .from("productos")
    .select(PRODUCTO_SELECT)
    .order("id", {
      ascending: false,
    })

  if (error) {
    throw error
  }

  return (data || []) as SupabaseProducto[]
}

export async function getProductoById(
  id: number
) {
  const { data, error } = await supabase
    .from("productos")
    .select(PRODUCTO_SELECT)
    .eq("id", id)
    .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

export async function getProductoBySlug(
  slug: string
) {
  const { data, error } = await supabase
    .from("productos")
    .select(PRODUCTO_SELECT)
    .eq("slug", slug)
    .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

export async function getFeaturedProductos() {
  const { data, error } = await supabase
    .from("productos")
    .select(PRODUCTO_SELECT)
    .eq("destacado", true)
    .eq("activo", true)
    .order("id", {
      ascending: false,
    })

  if (error) {
    throw error
  }

  return (data || []) as SupabaseProducto[]
}

// ─────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────

export async function createProducto(
  payload: ProductoPayload
) {
  const { data, error } = await supabase
    .from("productos")
    .insert(payload)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

export async function updateProducto(
  id: number,
  payload: Partial<ProductoPayload>
) {
  const { data, error } = await supabase
    .from("productos")
    .update(payload)
    .eq("id", id)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

export async function deleteProducto(
  id: number
) {
  const { data: imagenes } =
    await supabase
      .from(
        "imagenes_producto"
      )
      .select("url")
      .eq(
        "producto_id",
        id
      )

  const paths =
    imagenes
      ?.map((img) =>
        img.url.split(
          "/imagenes-productos/"
        )[1]
      )
      .filter(Boolean) || []

  if (paths.length) {
    await supabase.storage
      .from(
        "imagenes-productos"
      )
      .remove(paths)
  }

  await supabase
    .from(
      "imagenes_producto"
    )
    .delete()
    .eq(
      "producto_id",
      id
    )

  const { error } =
    await supabase
      .from("productos")
      .delete()
      .eq("id", id)

  if (error) {
    throw error
  }

  return true
}

export async function toggleProductoActivo(
  producto: SupabaseProducto
) {
  return updateProducto(producto.id, {
    activo: !producto.activo,
  })
}

// ─────────────────────────────────────────────────────────────
// Categorías
// ─────────────────────────────────────────────────────────────

export async function getCategorias() {
  const { data, error } = await supabase
    .from("categorias")
    .select("*")
    .order("nombre")

  if (error) {
    throw error
  }

  return (data || []) as SupabaseCategoria[]
}

export async function getCategoriaBySlug(
  slug: string
) {
  const { data, error } = await supabase
    .from("categorias")
    .select("*")
    .eq("slug", slug)
    .single()

  if (error) {
    throw error
  }

  return data as SupabaseCategoria
}