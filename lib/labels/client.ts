import { supabase } from "@/lib/supabase/client"

import type { LabelCatalogProduct } from "./catalog"
import type { BarcodePattern } from "./drawing"
import type { LabelBatchItem, LabelBatchOutput, LabelBatchSummary, LabelPreset } from "./history"
import type { LabelSettings } from "./settings"

export class LabelApiError extends Error {
  status: number
  code: string | null
  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new LabelApiError("Tu sesión venció. Volvé a ingresar.", 401, null)
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  })
  const data = (await response.json().catch(() => null)) as (T & { error?: unknown; code?: unknown }) | null
  if (!response.ok || !data) {
    throw new LabelApiError(
      typeof data?.error === "string" ? data.error : "No se pudo completar la operación.",
      response.status,
      typeof data?.code === "string" ? data.code : null,
    )
  }
  return data
}

export interface LabelCatalogPage { items: LabelCatalogProduct[]; hasMore: boolean }

export function searchLabelCatalog(query: string, offset: number, signal?: AbortSignal) {
  const params = new URLSearchParams({ q: query.trim(), offset: String(offset) })
  return request<LabelCatalogPage>(`/api/admin/labels/catalog?${params}`, { signal })
}

export async function loadLabelProducts(ids: readonly number[], signal?: AbortSignal) {
  const unique = [...new Set(ids)]
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(unique.length / 100) }, (_, index) =>
      request<LabelCatalogPage>(`/api/admin/labels/catalog?ids=${unique.slice(index * 100, index * 100 + 100).join(",")}`, { signal })),
  )
  return pages.flatMap((page) => page.items)
}

// Reutiliza "Generar código BEYONIX" de Productos (idempotente en la base).
export async function generateBeyonixVariantCode(productId: number, variantId: number) {
  await request<{ variant: unknown }>(`/api/admin/products/${productId}/variants/${variantId}/barcode`, { method: "POST" })
}

export async function fetchBarcodePatterns(codes: readonly string[], signal?: AbortSignal) {
  const unique = [...new Set(codes)]
  const results = await Promise.all(
    Array.from({ length: Math.ceil(unique.length / 500) }, (_, index) =>
      request<{ patterns: Record<string, BarcodePattern>; errors: Record<string, string> }>("/api/admin/labels/patterns", {
        method: "POST",
        body: JSON.stringify({ codes: unique.slice(index * 500, index * 500 + 500) }),
        signal,
      })),
  )
  return {
    patterns: Object.assign({}, ...results.map((result) => result.patterns)) as Record<string, BarcodePattern>,
    errors: Object.assign({}, ...results.map((result) => result.errors)) as Record<string, string>,
  }
}

export interface LabelConfigResponse {
  presets: LabelPreset[]
  preference: LabelSettings | null
  batches: LabelBatchSummary[]
  storageUnavailable: boolean
}

export function loadLabelConfig() {
  return request<LabelConfigResponse>("/api/admin/labels/config")
}

export function saveLabelPreference(settings: LabelSettings) {
  return request<{ settings: LabelSettings }>("/api/admin/labels/config", { method: "PUT", body: JSON.stringify({ settings }) })
}

export async function saveLabelPreset(name: string, settings: LabelSettings, overwrite = false) {
  return (await request<{ preset: LabelPreset }>("/api/admin/labels/presets", { method: "POST", body: JSON.stringify({ name, settings, overwrite }) })).preset
}

export function deleteLabelPreset(id: string) {
  return request<{ deleted: boolean }>(`/api/admin/labels/presets?id=${encodeURIComponent(id)}`, { method: "DELETE" })
}

export async function saveLabelBatch(name: string, items: LabelBatchItem[], output: LabelBatchOutput) {
  return (await request<{ batch: LabelBatchSummary | null }>("/api/admin/labels/batches", { method: "POST", body: JSON.stringify({ name, items, output }) })).batch
}
