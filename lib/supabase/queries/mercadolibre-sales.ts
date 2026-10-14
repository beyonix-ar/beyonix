import { supabase } from "@/lib/supabase/client"
import type { MercadoLibreImportRow, ParsedMercadoLibreReport } from "@/lib/mercadolibre/sales-report"
import {
  MERCADOLIBRE_IMPORT_CHUNK_ROWS,
  type MercadoLibrePreviewStatus,
} from "@/lib/mercadolibre/import-validation"
import { buildReturnReviewRequest, type ReturnReviewPayload } from "@/lib/mercadolibre/return-review-client"
import { AdminRequestError } from "@/lib/admin/request-error"

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
  occurred_at: string
  approved_at: string
  updated_at: string
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
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  })
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    throw new AdminRequestError(response.status,
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

/** Bloques de ≤ 500 filas y ≤ ~2,5 MB para no superar límites de request. */
export function chunkMercadoLibreRows<T>(rows: T[], maxBytes = 2_500_000) {
  const chunks: T[][] = []
  let current: T[] = []
  let currentBytes = 0
  for (const row of rows) {
    const bytes = JSON.stringify(row).length
    if (
      current.length &&
      (current.length >= MERCADOLIBRE_IMPORT_CHUNK_ROWS || currentBytes + bytes > maxBytes)
    ) {
      chunks.push(current)
      current = []
      currentBytes = 0
    }
    current.push(row)
    currentBytes += bytes
  }
  if (current.length) chunks.push(current)
  return chunks
}

export async function hashMercadoLibreFile(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export interface MercadoLibreImportPreview {
  statuses: MercadoLibrePreviewStatus[]
  previousImport: { id: string; created_at: string; source_file_name: string | null } | null
}

/** Compara el archivo con lo ya cargado. No escribe nada. */
export async function previewMercadoLibreImport(
  rows: MercadoLibreImportRow[],
  fileSha256: string,
  onProgress?: (done: number, total: number) => void,
): Promise<MercadoLibreImportPreview> {
  const chunks = chunkMercadoLibreRows(rows)
  const statuses: MercadoLibrePreviewStatus[] = []
  let previousImport: MercadoLibreImportPreview["previousImport"] = null
  for (const [index, chunk] of chunks.entries()) {
    const result = await request("/api/admin/mercadolibre-sales/import/preview", {
      method: "POST",
      body: JSON.stringify({ rows: chunk, fileSha256 }),
      signal: AbortSignal.timeout(60_000),
    })
    statuses.push(...((result?.statuses ?? []) as MercadoLibrePreviewStatus[]))
    previousImport ??= (result?.previousImport ?? null) as MercadoLibreImportPreview["previousImport"]
    onProgress?.(index + 1, chunks.length)
  }
  return { statuses, previousImport }
}

export interface MercadoLibreImportResult {
  batchId: string
  inserted: number
  updated: number
  unchanged: number
  duplicateRows: number
  linked: number
}

export class MercadoLibreImportInterruptedError extends Error {
  constructor(
    message: string,
    readonly completedChunks: number,
    readonly totalChunks: number,
    readonly partial: Omit<MercadoLibreImportResult, "batchId">,
  ) {
    super(message)
    this.name = "MercadoLibreImportInterruptedError"
  }
}

/**
 * Importa las filas válidas de un reporte dentro de un lote del historial.
 * Cada bloque es atómico; si uno falla se detiene, el lote queda "fallido"
 * con lo ya guardado, y reimportar el mismo archivo completa lo que falta
 * sin duplicar.
 */
export async function importMercadoLibreReport(input: {
  report: ParsedMercadoLibreReport
  fileName: string
  fileSha256: string
  onProgress?: (done: number, total: number) => void
}): Promise<MercadoLibreImportResult> {
  const { report } = input
  const created = await request("/api/admin/mercadolibre-sales/import/batches", {
    method: "POST",
    body: JSON.stringify({
      fileName: input.fileName,
      fileSha256: input.fileSha256,
      fileKind: report.fileKind,
      sheetName: report.sheetName,
      columns: report.columns.map(({ key, header, column }) => ({ key, header, column })),
      rowsRead: report.rowsRead,
      rowsValid: report.rows.length,
      rowsInvalid: report.invalidRows.length,
      invalidRows: report.invalidRows,
    }),
  })
  const batchId = String(created?.batchId ?? "")
  if (!batchId) throw new Error("No se pudo iniciar la importación.")

  const totals = { inserted: 0, updated: 0, unchanged: 0, duplicateRows: report.duplicateRows.length, linked: 0 }
  const chunks = chunkMercadoLibreRows(report.rows)
  for (const [index, chunk] of chunks.entries()) {
    try {
      const result = await request("/api/admin/mercadolibre-sales/import", {
        method: "POST",
        body: JSON.stringify({ batchId, rows: chunk }),
        signal: AbortSignal.timeout(120_000),
      })
      totals.inserted += Number(result?.inserted ?? 0)
      totals.updated += Number(result?.updated ?? 0)
      totals.unchanged += Number(result?.unchanged ?? 0)
      totals.duplicateRows += Number(result?.duplicateRows ?? 0)
      totals.linked += Number(result?.linked ?? 0)
      input.onProgress?.(index + 1, chunks.length)
    } catch (error) {
      const message =
        error instanceof Error && error.name !== "TimeoutError"
          ? error.message
          : "El servidor tardó demasiado en responder."
      await request("/api/admin/mercadolibre-sales/import/batches", {
        method: "PATCH",
        body: JSON.stringify({ batchId, status: "failed", errorMessage: message }),
      }).catch(() => null)
      throw new MercadoLibreImportInterruptedError(message, index, chunks.length, totals)
    }
  }

  await request("/api/admin/mercadolibre-sales/import/batches", {
    method: "PATCH",
    body: JSON.stringify({ batchId, status: "completed" }),
  })
  return { batchId, ...totals }
}

export interface MercadoLibreImportBatch {
  id: string
  created_at: string
  finished_at: string | null
  imported_by_email: string | null
  source_file_name: string | null
  file_kind: string | null
  rows_read: number
  rows_valid: number
  rows_invalid: number
  rows_duplicate_in_file: number
  inserted: number
  updated: number
  unchanged: number
  status: "processing" | "completed" | "failed" | "reverted" | "partially_reverted"
  error_message: string | null
  invalid_rows: Array<{ rowNumber: number; saleNumber: string | null; messages: string[] }>
  reverted_at: string | null
  reverted_count: number
  reversible_sales: number
  kept_sales: number
}

export async function getMercadoLibreImportBatches() {
  const data = await request("/api/admin/mercadolibre-sales/import/batches")
  return (data?.batches ?? []) as MercadoLibreImportBatch[]
}

export async function revertMercadoLibreImportBatch(batchId: string, expectedCount: number) {
  const data = await request(
    `/api/admin/mercadolibre-sales/import/batches/${encodeURIComponent(batchId)}/revert`,
    { method: "POST", body: JSON.stringify({ expectedCount }) },
  )
  return (data?.result ?? {}) as {
    deleted?: number
    kept_modified_later?: number
    kept_with_return_review?: number
    updated_not_reversible?: number
    status?: string
  }
}

export async function deleteMercadoLibreSale(id: string) {
  return request(`/api/admin/mercadolibre-sales?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}

export async function deleteAllMercadoLibreSales(expectedCount: number) {
  return request(
    `/api/admin/mercadolibre-sales?scope=all&expectedCount=${expectedCount}`,
    { method: "DELETE" },
  )
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
  payload: ReturnReviewPayload,
) {
  const operation = buildReturnReviewRequest(saleId, payload)
  return request(operation.path, operation.init)
}
