import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

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

// ─────────────────────────────────────────────────────────────────────────────
// Get categoría
// ─────────────────────────────────────────────────────────────────────────────

export async function getCategoria(
  id: number
) {
  const { data, error } =
    await supabase
      .from("categorias")
      .select("*")
      .eq("id", id)
      .single()

  if (error) {
    throw error
  }

  return data as SupabaseCategoria
}

// ─────────────────────────────────────────────────────────────────────────────
// Create categoría
// ─────────────────────────────────────────────────────────────────────────────

interface CreateCategoriaPayload {
  nombre: string
  slug: string
}

export async function createCategoria(
  payload: CreateCategoriaPayload
) {
  const { data, error } =
    await supabase
      .from("categorias")
      .insert(payload)
      .select()
      .single()

  if (error) {
    throw error
  }

  return data as SupabaseCategoria
}

// ─────────────────────────────────────────────────────────────────────────────
// Update categoría
// ─────────────────────────────────────────────────────────────────────────────

export async function updateCategoria(
  id: number,
  payload: Partial<CreateCategoriaPayload>
) {
  const { data, error } =
    await supabase
      .from("categorias")
      .update(payload)
      .eq("id", id)
      .select()
      .single()

  if (error) {
    throw error
  }

  return data as SupabaseCategoria
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete categoría
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteCategoria(
  id: number
) {
  const { error } =
    await supabase
      .from("categorias")
      .delete()
      .eq("id", id)

  if (error) {
    throw error
  }

  return true
}