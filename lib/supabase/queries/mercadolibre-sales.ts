import { supabase } from "@/lib/supabase/client"
import type { MercadoLibreImportRow } from "@/lib/mercadolibre/sales-report"
import { validateMercadoLibreImportBatch } from "@/lib/mercadolibre/import-integrity"

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
  return_review: MercadoLibreReturnReview | null
  costing: {
    match_key: string
    product_id: number | null
    variant_id: number | null
    catalog_sku: string | null
    standalone_key: string | null
    costable_units: number
    unit_cost: number | null
    merchandise_cost: number | null
  }
}

export interface MercadoLibreReturnReview {
  id: string
  mercadolibre_sale_id: string
  received_quantity: number
  sellable_quantity: number
  discounted_quantity: number
  non_sellable_quantity: number
  discount_percent: number | null
  discount_reason: string | null
  non_sellable_reason: string | null
  review_notes: string | null
  approved_at: string
}

export interface MercadoLibreCostCatalogVariant {
  id: number
  nombre: string
  sku?: string | null
  activo: boolean
}

export interface MercadoLibreCostCatalogProduct {
  id: number | string
  nombre: string
  activo: boolean
  sku?: string | null
  standalone_key?: string | null
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
  const validated = validateMercadoLibreImportBatch(rows)
  const imported = rows.length
  let replaced = 0
  let linked = 0
  let inserted = 0
  let updated = 0
  let unchanged = 0
  let duplicateRows = validated.duplicateRows
  for (let index = 0; index < validated.rows.length; index += 150) {
    const result = await request("/api/admin/mercadolibre-sales/import", {
      method: "POST",
      body: JSON.stringify({
        rows: validated.rows.slice(index, index + 150),
        sourceFileName,
      }),
    })
    replaced += Number(result?.replaced ?? 0)
    linked += Number(result?.linked ?? 0)
    inserted += Number(result?.inserted ?? 0)
    updated += Number(result?.updated ?? 0)
    unchanged += Number(result?.unchanged ?? 0)
    duplicateRows += Number(result?.duplicateRows ?? 0)
  }
  return {
    imported,
    replaced,
    linked,
    inserted,
    updated,
    unchanged,
    duplicateRows,
  }
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
  standaloneKey: string | null = null,
) {
  return request("/api/admin/mercadolibre-sales", {
    method: "PATCH",
    body: JSON.stringify({ matchKey, productId, variantId, standaloneKey }),
  })
}

export async function saveMercadoLibreReturnReview(
  saleId: string,
  payload: {
    receivedQuantity: number
    sellableQuantity: number
    discountedQuantity: number
    nonSellableQuantity: number
    discountPercent: number | null
    discountReason: string
    nonSellableReason: string
    notes: string
  },
) {
  return request(
    `/api/admin/mercadolibre-sales/${encodeURIComponent(saleId)}/return-review`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  )
}
