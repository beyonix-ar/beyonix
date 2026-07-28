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

export interface ProductVariantAllocation {
  variant_id: number
  allocated_quantity: number
  available_quantity: number
}

export interface ProductVariantDistribution {
  totalStock: number
  assignableQuantity: number
  allocatedQuantity: number
  unassignedQuantity: number
  variants: ProductVariantAllocation[]
}

async function distributionRequest(
  productId: number,
  init?: RequestInit,
) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) {
    throw new Error("La sesión administrativa venció.")
  }

  const response = await fetch(
    `/api/admin/products/${productId}/variant-allocations`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    },
  )
  const payload = (await response.json().catch(() => null)) as
    | (ProductVariantDistribution & { error?: string })
    | null
  if (!response.ok || !payload) {
    throw new Error(
      payload?.error || "No se pudo actualizar la distribución del stock.",
    )
  }

  return payload
}

export function getProductVariantDistribution(productId: number) {
  return distributionRequest(productId)
}

export function saveProductVariantDistribution(
  productId: number,
  allocations: Array<{ variant_id: number; quantity: number }>,
) {
  return distributionRequest(productId, {
    method: "PUT",
    body: JSON.stringify({ allocations }),
  })
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
  const catalogPayload = { ...payload }
  delete catalogPayload.stock
  const { data, error } = await supabase
    .from("producto_variantes")
    .insert(catalogPayload)
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
  const catalogPayload = { ...payload }
  delete catalogPayload.stock
  const { data, error } = await supabase
    .from("producto_variantes")
    .update(catalogPayload)
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
