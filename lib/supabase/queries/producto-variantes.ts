import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseProductoVariante,
} from "@/lib/supabase/types"

export interface ProductoVariantePayload {
  producto_id: number
  nombre: string
  color_hex: string
  stock?: number | null
  imagenes?: string[]
  activo?: boolean
  orden?: number
}

export async function getProductoVariantes(
  productoId: number
) {
  const { data, error } = await supabase
    .from("producto_variantes")
    .select("*")
    .eq("producto_id", productoId)
    .order("orden", {
      ascending: true,
    })
    .order("id", {
      ascending: true,
    })

  if (error) {
    throw error
  }

  return (data || []) as SupabaseProductoVariante[]
}

export async function createProductoVariante(
  payload: ProductoVariantePayload
) {
  const { data, error } = await supabase
    .from("producto_variantes")
    .insert(payload)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data as SupabaseProductoVariante
}

export async function updateProductoVariante(
  id: number,
  payload: Partial<ProductoVariantePayload>
) {
  const { data, error } = await supabase
    .from("producto_variantes")
    .update(payload)
    .eq("id", id)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data as SupabaseProductoVariante
}

export async function deleteProductoVariante(
  id: number
) {
  const { error } = await supabase
    .from("producto_variantes")
    .delete()
    .eq("id", id)

  if (error) {
    throw error
  }

  return true
}
