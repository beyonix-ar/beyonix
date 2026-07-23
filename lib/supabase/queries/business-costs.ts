import { supabase } from "@/lib/supabase/client"

export interface BusinessCostCatalogVariant {
  id: number
  nombre: string
  activo: boolean
  stock: number | null
}

export interface BusinessCostCatalogProduct {
  id: number
  nombre: string
  activo: boolean
  stock: number | null
  producto_variantes?: BusinessCostCatalogVariant[]
}

export interface ProductCostEntry {
  id: string
  product_id: number
  variant_id: number | null
  purchase_date: string
  quantity: number
  unit_cost: number
  freight_cost: number
  tax_cost: number
  commission_cost: number
  other_cost: number
  total_cost: number
  supplier: string | null
  document_type: string | null
  document_number: string | null
  payment_method: string | null
  notes: string | null
  created_at: string
}

export interface BusinessExpense {
  id: string
  expense_date: string
  category: string
  description: string | null
  amount: number
  recurrence: "unico" | "mensual" | "bimestral" | "trimestral" | "semestral" | "anual"
  status: "pendiente" | "pagado"
  supplier: string | null
  payment_method: string | null
  document_type: string | null
  document_number: string | null
  tax_deductible: boolean
  notes: string | null
  created_at: string
}

export interface BusinessCostsData {
  catalog: BusinessCostCatalogProduct[]
  productCosts: ProductCostEntry[]
  expenses: BusinessExpense[]
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
  const data = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null

  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string" ? data.error : "No se pudo completar la operación.",
    )
  }

  return data
}

export async function getBusinessCosts() {
  return (await request("/api/admin/costs")) as unknown as BusinessCostsData
}

export async function createBusinessCost(payload: Record<string, unknown>) {
  return request("/api/admin/costs", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function deleteBusinessCost(kind: "product" | "expense", id: string) {
  return request(`/api/admin/costs?kind=${kind}&id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}
