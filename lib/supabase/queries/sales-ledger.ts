import { supabase } from "@/lib/supabase/client"

export type SalesLedgerChannel = "external" | "ml"

export interface SalesLedgerCatalogProduct {
  id: number
  nombre: string
  precio: number
  unit_cost: number | null
  activo: boolean
  producto_variantes?: Array<{
    id: number
    nombre: string
    activo: boolean
  }>
}

export interface SalesLedgerRow {
  id: string
  sale_date: string
  product_id: number | null
  product_name: string
  sku: string | null
  quantity: number
  unit_price: number | null
  unit_cost: number
  gross_amount: number
  fee_type: "amount" | "percent"
  fee_value: number
  fee_amount: number | null
  shipping_amount: number | null
  other_expense_amount: number
  net_amount: number | null
  payment_method: string | null
  reference: string | null
  customer_name: string | null
  notes: string | null
  created_at: string
  updated_at: string | null
}

export interface SalesLedgerData {
  catalog: SalesLedgerCatalogProduct[]
  externalSales: SalesLedgerRow[]
  mlSales: SalesLedgerRow[]
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

export async function getSalesLedger() {
  return (await request("/api/admin/sales-ledger")) as unknown as SalesLedgerData
}

export async function saveSalesLedgerRow(
  payload: Record<string, unknown>,
  id?: string,
) {
  return request("/api/admin/sales-ledger", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(id ? { ...payload, id } : payload),
  })
}

export async function deleteSalesLedgerRow(channel: SalesLedgerChannel, id: string) {
  return request(
    `/api/admin/sales-ledger?channel=${channel}&id=${encodeURIComponent(id)}`,
    { method: "DELETE" },
  )
}
