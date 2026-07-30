import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseProductoVariante,
} from "@/lib/supabase/types"

export interface ProductoVariantePayload {
  producto_id: number
  nombre: string
  sku?: string | null
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

async function authenticatedVariantRequest(
  path: string,
  init: RequestInit = {},
) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) {
    throw new Error("La sesión administrativa venció. Volvé a iniciar sesión.")
  }

  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
  })
  const payload = (await response.json().catch(() => null)) as
    | {
        variant?: SupabaseProductoVariante
        variants?: SupabaseProductoVariante[]
        error?: string
      }
    | null

  if (!response.ok) {
    throw new Error(payload?.error || "No se pudo guardar la variante.")
  }

  return payload
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
  const response = await authenticatedVariantRequest(
    `/api/admin/products/${productoId}/variants`,
  )

  return response?.variants ?? []
}

export async function getAdminProductoVariantes() {
  const response = await authenticatedVariantRequest(
    "/api/admin/product-variants",
  )

  return response?.variants ?? []
}

export async function createProductoVariante(
  payload: ProductoVariantePayload
) {
  const catalogPayload = { ...payload }
  delete catalogPayload.stock
  const response = await authenticatedVariantRequest(
    `/api/admin/products/${payload.producto_id}/variants`,
    {
      method: "POST",
      body: JSON.stringify(catalogPayload),
    },
  )

  if (!response?.variant) {
    throw new Error("No se pudo crear la variante.")
  }

  return response.variant
}

export async function updateProductoVariante(
  productId: number,
  id: number,
  payload: Partial<ProductoVariantePayload>
) {
  const catalogPayload = { ...payload }
  delete catalogPayload.producto_id
  delete catalogPayload.stock
  const response = await authenticatedVariantRequest(
    `/api/admin/products/${productId}/variants/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify(catalogPayload),
    },
  )

  if (!response?.variant) {
    throw new Error("No se pudo actualizar la variante.")
  }

  return response.variant
}

export async function setProductoVarianteActivo(
  productId: number,
  variantId: number,
  activo: boolean,
) {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error(
      "La sesión administrativa venció. Volvé a iniciar sesión.",
    )
  }

  const response = await fetch(
    `/api/admin/products/${productId}/variants/${variantId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ activo }),
      cache: "no-store",
    },
  )
  const payload = (await response.json().catch(() => null)) as
    | {
        variant?: SupabaseProductoVariante
        error?: string
      }
    | null

  if (!response.ok || !payload?.variant) {
    throw new Error(
      payload?.error || "No se pudo cambiar el estado de la variante.",
    )
  }

  return payload.variant
}

export async function deleteProductoVariante(
  productId: number,
  id: number
) {
  await authenticatedVariantRequest(
    `/api/admin/products/${productId}/variants/${id}`,
    { method: "DELETE" },
  )

  return true
}
