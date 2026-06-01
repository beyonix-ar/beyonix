import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

const CATEGORIA_IMAGES_BUCKET =
  "imagenes-productos"

function getCategoriaImagePath(file: File) {
  const ext =
    file.name.split(".").pop() || "jpg"

  return `categorias/${crypto.randomUUID()}.${ext}`
}

function getStoragePathFromUrl(url: string) {
  return url.split(`/${CATEGORIA_IMAGES_BUCKET}/`)[1] ?? null
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
  descripcion?: string | null
  imagen?: string | null
  destacado?: boolean
  posicion_destacada?: 1 | 2 | 3 | null
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

export async function uploadCategoriaImage(file: File) {
  if (!file.type.startsWith("image/")) {
    throw new Error("El archivo debe ser una imagen.")
  }

  const path = getCategoriaImagePath(file)

  const { data, error } = await supabase.storage
    .from(CATEGORIA_IMAGES_BUCKET)
    .upload(path, file)

  if (error) {
    throw error
  }

  const {
    data: { publicUrl },
  } = supabase.storage
    .from(CATEGORIA_IMAGES_BUCKET)
    .getPublicUrl(data.path)

  return publicUrl
}

export async function deleteCategoriaImageByUrl(url: string) {
  const path = getStoragePathFromUrl(url)

  if (!path) {
    return true
  }

  const { error } = await supabase.storage
    .from(CATEGORIA_IMAGES_BUCKET)
    .remove([path])

  if (error) {
    throw error
  }

  return true
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
