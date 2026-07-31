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
  /** @deprecated Usar normalStock. */
  totalStock: number
  normalStock: number
  discountedStock: number
  nonSellableStock: number
  pendingReviewStock: number
  sellableStock: number
  quarantineStock: number
  physicalStock: number
  genericBalance: number
  assignableQuantity: number
  allocatedQuantity: number
  unassignedQuantity: number
  allocationOverflow: number
  variants: ProductVariantAllocation[]
}

async function variantRequest<T>(
  path: string,
  init?: RequestInit,
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
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  })
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null

  if (!response.ok || !payload) {
    throw new Error(
      payload?.error || "No se pudo completar la operación con la variante.",
    )
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

export async function getProductoVariantes(
  productoId: number
) {
  const result = await variantRequest<{
    variants: SupabaseProductoVariante[]
  }>(`/api/admin/products/${productoId}/variants`)

  return result.variants
}

export async function getAdminProductoVariantes(options: {
  productIds?: number[]
  skuSearch?: string
  colorSearch?: string
} = {}): Promise<SupabaseProductoVariante[]> {
  const requestedProductIds = [
    ...new Set(
      (options.productIds ?? []).filter(
        (id) => Number.isInteger(id) && id > 0,
      ),
    ),
  ]
  if (options.productIds?.length && requestedProductIds.length === 0) {
    return []
  }
  if (requestedProductIds.length > 100) {
    const chunks: number[][] = []
    for (let index = 0; index < requestedProductIds.length; index += 100) {
      chunks.push(requestedProductIds.slice(index, index + 100))
    }

    const results: SupabaseProductoVariante[][] = await Promise.all(
      chunks.map((productIds) =>
        getAdminProductoVariantes({
          ...options,
          productIds,
        }),
      ),
    )
    return results.flat()
  }

  const searchParams = new URLSearchParams()
  if (requestedProductIds.length) {
    searchParams.set("productIds", requestedProductIds.join(","))
  }
  if (options.skuSearch?.trim()) {
    searchParams.set("skuSearch", options.skuSearch.trim())
  }
  if (options.colorSearch?.trim()) {
    searchParams.set("colorSearch", options.colorSearch.trim())
  }
  const query = searchParams.size ? `?${searchParams.toString()}` : ""
  const result = await variantRequest<{
    variants: SupabaseProductoVariante[]
  }>(`/api/admin/product-variants${query}`)

  return result.variants
}

export async function createProductoVariantWithAllocation(
  productId: number,
  payload: {
    name: string
    sku: string | null
    color: string
    quantity: number
    images: string[]
  },
) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) {
    throw new Error(
      "La sesión administrativa venció. Volvé a iniciar sesión.",
    )
  }

  const response = await fetch(`/api/admin/products/${productId}/variants`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  })
  const result = (await response.json().catch(() => null)) as
    | {
        variant?: SupabaseProductoVariante
        error?: string
      }
    | null

  if (!response.ok || !result?.variant) {
    throw new Error(
      result?.error || "No se pudo crear y distribuir la variante.",
    )
  }

  return result.variant
}

export async function updateProductoVariantWithAllocation(
  productId: number,
  variantId: number,
  payload: {
    name: string
    sku: string | null
    color: string
    quantity: number
    images: string[]
  },
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
      body: JSON.stringify(payload),
      cache: "no-store",
    },
  )
  const result = (await response.json().catch(() => null)) as
    | {
        variant?: SupabaseProductoVariante
        error?: string
      }
    | null

  if (!response.ok || !result?.variant) {
    throw new Error(
      result?.error || "No se pudo actualizar y distribuir la variante.",
    )
  }

  return result.variant
}

export async function updateProductoVariante(
  productId: number,
  id: number,
  payload: Partial<ProductoVariantePayload>
) {
  const catalogPayload = { ...payload }
  delete catalogPayload.producto_id
  delete catalogPayload.stock
  delete catalogPayload.producto_id
  delete catalogPayload.activo

  const result = await variantRequest<{
    variant: SupabaseProductoVariante
  }>(`/api/admin/products/${productId}/variants/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ metadata: catalogPayload }),
  })

  return result.variant
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
  id: number,
) {
  await variantRequest<{ deleted: boolean }>(
    `/api/admin/products/${productId}/variants/${id}`,
    { method: "DELETE" },
  )

  return true
}
