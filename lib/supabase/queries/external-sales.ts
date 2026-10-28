import { supabase } from "@/lib/supabase/client"
import type { ExternalSaleCostStatus } from "@/lib/business/external-sale-profitability"
import type {
  ExternalSale,
  ExternalSaleActiveStatus,
  ExternalSaleChannel,
  ExternalSaleImportBatch,
  ExternalSaleImportRowPayload,
  ExternalSalePaymentMethod,
  ExternalSalePreviewServerRow,
  ExternalSaleReturnCondition,
  ExternalSaleStockEffect,
} from "@/lib/business/external-sales"

export interface ExternalSaleListItem extends ExternalSale {
  profit_amount: number | null
  profit_source: "declared" | "calculated" | null
  cost_amount: number | null
  cost_status: ExternalSaleCostStatus
}

export interface ExternalSaleFilters {
  from?: string
  to?: string
  channel?: ExternalSaleChannel | "none" | ""
  status?: "active" | "completed" | "delivered" | "reversed" | ""
  stockEffect?: ExternalSaleStockEffect | ""
  sku?: string
  batch?: string
}

export interface ExternalSaleDetail {
  sale: ExternalSaleListItem & {
    source_values: Record<string, string> | null
    created_by_name: string | null
    reversed_by_name: string | null
  }
  batch: {
    id: string
    created_at: string
    source: "paste" | "file"
    file_name: string | null
    stock_mode: ExternalSaleStockEffect
    rows_imported: number
    status: "completed" | "reverted"
  } | null
  catalog: {
    product: { id: number; nombre: string; sku: string | null; activo: boolean } | null
    variant: { id: number; nombre: string; sku: string | null; activo: boolean } | null
  }
  history: Array<{
    id: number
    created_at: string
    actor_name: string | null
    label: string
    reason: string | null
    changes: Array<{ field: string; before: unknown; after: unknown }>
  }>
}

export interface ExternalSaleCatalogProduct {
  id: number
  nombre: string
  sku: string | null
  activo: boolean
  stock: number
  producto_variantes: Array<{ id: number; nombre: string; sku: string | null; activo: boolean; stock: number }>
}

/** Campos editables, con los nombres que espera la API. */
export interface ExternalSaleFields {
  saleDate: string
  customerName: string | null
  channel: ExternalSaleChannel
  sku: string | null
  productName: string | null
  quantity: number
  shippingAmount: number
  paymentMethodCode: ExternalSalePaymentMethod | null
  status: ExternalSaleActiveStatus
  finalPrice: number
  declaredProfit: number | null
  notes: string | null
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
    throw new Error(typeof data?.error === "string" ? data.error : "No se pudo completar la operación.")
  }
  return data ?? {}
}

export async function getExternalSales(filters: ExternalSaleFilters = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.trim()) params.set(key, value.trim())
  }
  const query = params.toString()
  const data = await request(`/api/admin/external-sales${query ? `?${query}` : ""}`)
  return { sales: (data.sales ?? []) as ExternalSaleListItem[], truncated: data.truncated === true }
}

export async function getExternalSaleDetail(id: string) {
  return (await request(`/api/admin/external-sales/${encodeURIComponent(id)}`)) as unknown as ExternalSaleDetail
}

export async function getExternalSalesCatalog() {
  return ((await request("/api/admin/external-sales/catalog")).products ?? []) as ExternalSaleCatalogProduct[]
}

export async function createExternalSale(
  fields: ExternalSaleFields & { stockEffect: ExternalSaleStockEffect; productId: number | null; variantId: number | null },
  idempotencyKey: string,
) {
  return (await request("/api/admin/external-sales", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(fields),
  })).sale as ExternalSaleListItem
}

export async function updateExternalSale(id: string, version: number, changes: Partial<ExternalSaleFields>, reason: string) {
  return (await request(`/api/admin/external-sales/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ version, changes, reason }),
  })).sale as ExternalSaleListItem
}

export async function cancelExternalSale(
  id: string,
  input: {
    kind: "entry_error" | "return"
    returnCondition: ExternalSaleReturnCondition | null
    reason: string
    idempotencyKey: string
    version: number
  },
) {
  return (await request(`/api/admin/external-sales/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify(input),
  })).sale as ExternalSaleListItem
}

export async function previewExternalSalesImport(rows: ExternalSaleImportRowPayload[]) {
  const data = await request("/api/admin/external-sales/import/preview", {
    method: "POST",
    body: JSON.stringify({ rows }),
  })
  return data.preview as { rows: ExternalSalePreviewServerRow[]; previous_batch: { id: string; created_at: string } | null }
}

export async function importExternalSales(
  input: {
    source: "paste" | "file"
    fileName: string | null
    stockMode: ExternalSaleStockEffect
    rowsRead: number
    rows: ExternalSaleImportRowPayload[]
  },
  idempotencyKey: string,
) {
  const data = await request("/api/admin/external-sales/import", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  })
  return data.result as { batch_id: string; imported: number; stock_mode: ExternalSaleStockEffect; replayed: boolean }
}

export async function getExternalSaleImportBatches() {
  return ((await request("/api/admin/external-sales/import-batches")).batches ?? []) as ExternalSaleImportBatch[]
}

export async function revertExternalSaleImportBatch(id: string, expectedCount: number, reason: string) {
  return (await request(`/api/admin/external-sales/import-batches/${encodeURIComponent(id)}/revert`, {
    method: "POST",
    body: JSON.stringify({ expectedCount, reason }),
  })).result as { reverted: number; status: "reverted"; replayed: boolean }
}
