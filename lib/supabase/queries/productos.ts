import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseProducto,
  SupabaseCategoria,
} from "@/lib/supabase/types"

// ─────────────────────────────────────────────────────────────────────────────
// Get productos
// ─────────────────────────────────────────────────────────────────────────────

export async function getProductos() {
  const { data, error } =
    await supabase
      .from("productos")
      .select(`
        *,
        categorias(*),
        imagenes_producto(*)
      `)
      .order("id", {
        ascending: false,
      })

  if (error) {
    throw error
  }

  return (data ??
    []) as SupabaseProducto[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Get producto
// ─────────────────────────────────────────────────────────────────────────────

export async function getProducto(
  id: number
) {
  const { data, error } =
    await supabase
      .from("productos")
      .select(`
        *,
        categorias(*),
        imagenes_producto(*)
      `)
      .eq("id", id)
      .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

// ─────────────────────────────────────────────────────────────────────────────
// Create producto
// ─────────────────────────────────────────────────────────────────────────────

interface CreateProductoPayload {
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

export async function createProducto(
  payload: CreateProductoPayload
) {
  const { data, error } =
    await supabase
      .from("productos")
      .insert(payload)
      .select()
      .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

// ─────────────────────────────────────────────────────────────────────────────
// Update producto
// ─────────────────────────────────────────────────────────────────────────────

export async function updateProducto(
  id: number,
  payload: Partial<CreateProductoPayload>
) {
  const { data, error } =
    await supabase
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

// ─────────────────────────────────────────────────────────────────────────────
// Delete producto
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteProducto(
  id: number
) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Toggle activo
// ─────────────────────────────────────────────────────────────────────────────

export async function toggleProductoActivo(
  producto: SupabaseProducto
) {
  const { data, error } =
    await supabase
      .from("productos")
      .update({
        activo: !producto.activo,
      })
      .eq("id", producto.id)
      .select()
      .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

// ─────────────────────────────────────────────────────────────────────────────
// Get categorías
// ─────────────────────────────────────────────────────────────────────────────

export async function getCategorias() {
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