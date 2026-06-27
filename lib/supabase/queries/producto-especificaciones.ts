import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseProductoEspecificacion,
} from "@/lib/supabase/types"

interface ProductoEspecificacionPayload {
  producto_id: number
  icono: string
  texto: string
  orden?: number
  activo?: boolean
}

interface DraftProductoEspecificacionPayload {
  icono: string
  texto: string
  orden: number
  activo: boolean
}

type SupabaseLikeError = {
  message?: string
  details?: string
  hint?: string
  code?: string
}

function assertProductoId(productoId: number) {
  if (!Number.isFinite(productoId) || productoId <= 0) {
    throw new Error(
      `producto_id invalido para producto_especificaciones: ${productoId}`
    )
  }
}

function getSupabaseErrorMessage(error: SupabaseLikeError) {
  const message = [
    error.message,
    error.details,
    error.hint,
    error.code ? `Codigo: ${error.code}` : null,
  ]
    .filter(Boolean)
    .join(" | ")

  return message || "Error desconocido de Supabase."
}

function logSupabaseError(
  action: string,
  error: SupabaseLikeError,
  payload?: unknown
) {
  console.error(`Error Supabase producto_especificaciones (${action})`, {
    message: error.message,
    details: error.details,
    hint: error.hint,
    code: error.code,
    payload,
  })
}

export async function getProductoEspecificaciones(productoId: number) {
  assertProductoId(productoId)

  const { data, error } = await supabase
    .from("producto_especificaciones")
    .select("*")
    .eq("producto_id", productoId)
    .order("orden", {
      ascending: true,
    })
    .order("id", {
      ascending: true,
    })

  if (error) {
    logSupabaseError("select", error, {
      producto_id: productoId,
    })
    throw error
  }

  return (data || []) as SupabaseProductoEspecificacion[]
}

export async function createProductoEspecificacion(
  payload: ProductoEspecificacionPayload
) {
  assertProductoId(payload.producto_id)

  const cleanPayload = {
    producto_id: payload.producto_id,
    icono: payload.icono.trim(),
    texto: payload.texto.trim(),
    orden: Number(payload.orden) || 1,
    activo: payload.activo ?? true,
  }

  const { data, error } = await supabase
    .from("producto_especificaciones")
    .insert(cleanPayload)
    .select()
    .single()

  if (error) {
    logSupabaseError("insert", error, cleanPayload)
    throw new Error(getSupabaseErrorMessage(error))
  }

  return data as SupabaseProductoEspecificacion
}

export async function updateProductoEspecificacion(
  id: number,
  payload: Partial<ProductoEspecificacionPayload>
) {
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`id invalido para producto_especificaciones: ${id}`)
  }

  const cleanPayload = {
    ...(payload.producto_id !== undefined
      ? {
          producto_id: payload.producto_id,
        }
      : {}),
    ...(payload.icono !== undefined
      ? {
          icono: payload.icono.trim(),
        }
      : {}),
    ...(payload.texto !== undefined
      ? {
          texto: payload.texto.trim(),
        }
      : {}),
    ...(payload.orden !== undefined
      ? {
          orden: Number(payload.orden) || 1,
        }
      : {}),
    ...(payload.activo !== undefined
      ? {
          activo: payload.activo,
        }
      : {}),
  }

  if (cleanPayload.producto_id !== undefined) {
    assertProductoId(cleanPayload.producto_id)
  }

  const { data, error } = await supabase
    .from("producto_especificaciones")
    .update(cleanPayload)
    .eq("id", id)
    .select()
    .single()

  if (error) {
    logSupabaseError("update", error, {
      id,
      payload: cleanPayload,
    })
    throw new Error(getSupabaseErrorMessage(error))
  }

  return data as SupabaseProductoEspecificacion
}

export async function deleteProductoEspecificacion(id: number) {
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`id invalido para producto_especificaciones: ${id}`)
  }

  const { error } = await supabase
    .from("producto_especificaciones")
    .delete()
    .eq("id", id)

  if (error) {
    logSupabaseError("delete", error, {
      id,
    })
    throw new Error(getSupabaseErrorMessage(error))
  }

  return true
}

export async function updateProductoEspecificacionesOrden(
  items: Array<{
    id: number
    orden: number
  }>
) {
  await Promise.all(
    items.map((item) =>
      updateProductoEspecificacion(item.id, {
        orden: item.orden,
      })
    )
  )
}

export async function saveDraftProductoEspecificaciones(
  productoId: number,
  draftSpecifications: DraftProductoEspecificacionPayload[]
) {
  assertProductoId(productoId)

  const cleanSpecifications = draftSpecifications
    .map((spec, index) => ({
      producto_id: productoId,
      icono: spec.icono.trim(),
      texto: spec.texto.trim(),
      orden: Number(spec.orden) || index + 1,
      activo: spec.activo,
    }))
    .filter((spec) => spec.icono && spec.texto)

  if (!cleanSpecifications.length) {
    return []
  }

  const { data, error } = await supabase
    .from("producto_especificaciones")
    .insert(cleanSpecifications)
    .select()

  if (error) {
    logSupabaseError("bulk insert", error, cleanSpecifications)
    throw new Error(getSupabaseErrorMessage(error))
  }

  return (data || []) as SupabaseProductoEspecificacion[]
}
