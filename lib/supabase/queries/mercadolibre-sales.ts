import { supabase } from "@/lib/supabase/client"
import type { MercadoLibreImportRow } from "@/lib/mercadolibre/sales-report"

export interface StoredMercadoLibreSale {
  id: string
  sale_date: string | null
  operation_id: string | null
  order_id: string | null
  product_id: number | null
  product_name: string
  sku: string | null
  quantity: number
  unit_cost: number | null
  gross_amount: number
  fee_amount: number | null
  shipping_amount: number | null
  net_amount: number | null
  source_file_name: string | null
  imported_at: string
  raw_data: MercadoLibreImportRow["raw_data"] | Record<string, unknown>
  costing: {
    match_key: string
    product_id: number | null
    variant_id: number | null
    costable_units: number
    unit_cost: number | null
    merchandise_cost: number | null
  }
}

export interface MercadoLibreCostCatalogVariant {
  id: number
  nombre: string
  activo: boolean
}

export interface MercadoLibreCostCatalogProduct {
  id: number
  nombre: string
  activo: boolean
  producto_variantes?: MercadoLibreCostCatalogVariant[]
}

export interface MercadoLibreSalesData {
  rows: StoredMercadoLibreSale[]
  catalog: MercadoLibreCostCatalogProduct[]
  costingError: string | null
}

async function request(path: string, init?: RequestInit) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("La sesión administrativa venció.")

  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  })
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string" ? data.error : "No se pudo completar la operación.",
    )
  }
  return data
}

export async function getMercadoLibreSales() {
  const data = await request("/api/admin/mercadolibre-sales")
  return {
    rows: (data?.rows ?? []) as unknown as StoredMercadoLibreSale[],
    catalog: (data?.catalog ??
      []) as unknown as MercadoLibreCostCatalogProduct[],
    costingError:
      typeof data?.costingError === "string" ? data.costingError : null,
  } satisfies MercadoLibreSalesData
}

export async function importMercadoLibreSales(
  rows: MercadoLibreImportRow[],
  sourceFileName: string,
) {
  let imported = 0
  let replaced = 0
  for (let index = 0; index < rows.length; index += 150) {
    const result = await request("/api/admin/mercadolibre-sales/import", {
      method: "POST",
      body: JSON.stringify({
        rows: rows.slice(index, index + 150),
        sourceFileName,
      }),
    })
    imported += Number(result?.imported ?? 0)
    replaced += Number(result?.replaced ?? 0)
  }
  return { imported, replaced }
}

export async function deleteMercadoLibreSale(id: string) {
  return request(`/api/admin/mercadolibre-sales?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}

export async function saveMercadoLibreCostMapping(
  matchKey: string,
  productId: number | null,
  variantId: number | null,
) {
  return request("/api/admin/mercadolibre-sales", {
    method: "PATCH",
    body: JSON.stringify({ matchKey, productId, variantId }),
  })
}
