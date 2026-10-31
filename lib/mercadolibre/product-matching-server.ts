import type { createAdminClient } from "../supabase/admin.ts"

import { getMercadoLibreSaleIdentity } from "./import-integrity.ts"
import {
  buildMercadoLibreMatchingContext,
  resolveMercadoLibreProductMatch,
  type MercadoLibreMatchingContext,
  type MercadoLibreProductMatch,
  type ProductChannelMapping,
} from "./product-matching.ts"
import { normalizeMercadoLibreSku } from "./sku-aliases.ts"
import { buildUniqueCatalogTargetsBySku, type CatalogSkuRow } from "./sku-reconciliation.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export interface MercadoLibreCatalogProduct {
  id: number
  nombre: string
  sku: string | null
  activo: boolean
  producto_variantes: Array<{ id: number; nombre: string; sku: string | null; activo: boolean }> | null
}

export interface PreservedCostMapping {
  product_id: number
  variant_id: number | null
  match_key: string
  mapped_at?: string
  mapped_by?: string
  canonical_sku?: string
  mapping_origin?: string
  unit_cost: number
}

interface ExistingSaleRow {
  id: string
  sale_date: string | null
  operation_id: string | null
  order_id: string | null
  sku: string | null
  product_name: string
  product_id: number | null
  unit_cost: number | null
  raw_data: Record<string, unknown> | null
  stock_effect?: string | null
}

export interface MercadoLibreMatchableServerRow {
  sale_date: string
  operation_id: string
  order_id: string
  product_name: string
  sku: string | null
  raw_data: Record<string, unknown>
}

export class MercadoLibreMatchingLoadError extends Error {
  /** Mensaje técnico de la base (sólo para logs y detección de migraciones). */
  readonly detail: string

  constructor(message: string, detail: string) {
    super(message)
    this.name = "MercadoLibreMatchingLoadError"
    this.detail = detail
  }
}

function rawObject(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

export function mercadoLibreMappingKey(sku: unknown, productName: unknown) {
  const normalizedSku = normalizeMercadoLibreSku(sku)
  return normalizedSku ? `sku:${normalizedSku}` : `product:${String(productName ?? "").trim()}`
}

function finiteOrNull(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function getPreservedCostMapping(row: ExistingSaleRow): PreservedCostMapping | null {
  const stored = rawObject(rawObject(row.raw_data).beyonix_cost_mapping)
  const productId = Number(stored.product_id ?? row.product_id ?? 0)
  if (!Number.isInteger(productId) || productId <= 0) return null
  const variantId = Number(stored.variant_id ?? 0)
  return {
    product_id: productId,
    variant_id: Number.isInteger(variantId) && variantId > 0 ? variantId : null,
    match_key: typeof stored.match_key === "string" ? stored.match_key : mercadoLibreMappingKey(row.sku, row.product_name),
    mapped_at: typeof stored.mapped_at === "string" ? stored.mapped_at : undefined,
    mapped_by: typeof stored.mapped_by === "string" ? stored.mapped_by : undefined,
    canonical_sku: typeof stored.canonical_sku === "string" ? stored.canonical_sku : undefined,
    mapping_origin: typeof stored.mapping_origin === "string" ? stored.mapping_origin : undefined,
    unit_cost: finiteOrNull(row.unit_cost) ?? 0,
  }
}

export interface MercadoLibreMatchingData {
  catalog: MercadoLibreCatalogProduct[]
  context: MercadoLibreMatchingContext
  preservedByIdentity: Map<string, PreservedCostMapping>
  /** Identidades de ventas que ya existen en BEYONIX. */
  existingIdentities: Set<string>
  /**
   * Ventas consume legadas sin producto: vincularlas genera su salida de
   * stock, así que nunca se vinculan solas (sólo por acción explícita).
   */
  pendingManualLink: Set<string>
}

type MatchingInput = Pick<MercadoLibreMatchingData, "context" | "preservedByIdentity"> &
  Partial<Pick<MercadoLibreMatchingData, "existingIdentities" | "pendingManualLink">>

/** Catálogo, vínculos explícitos activos y vínculos ya guardados de esas ventas. */
export async function loadMercadoLibreMatchingData(
  admin: AdminClient,
  rows: MercadoLibreMatchableServerRow[],
): Promise<MercadoLibreMatchingData> {
  const operationIds = Array.from(new Set(rows.map((row) => row.operation_id)))
  const existingChunks: Array<Promise<{ data: unknown[] | null; error: { message: string } | null }>> = []
  for (let index = 0; index < operationIds.length; index += 400) {
    existingChunks.push(
      Promise.resolve(
        admin
          .from("mercadolibre_sales")
          .select("id, sale_date, operation_id, order_id, sku, product_name, product_id, unit_cost, raw_data, stock_effect")
          .in("operation_id", operationIds.slice(index, index + 400)),
      ),
    )
  }

  const [catalogResult, mappingsResult, ...existingResults] = await Promise.all([
    admin.from("productos").select("id, nombre, sku, activo, producto_variantes(id, nombre, sku, activo)"),
    admin
      .from("product_channel_mappings")
      .select("id, mapping_type, match_key, product_id, variant_id, origin, valid_from, valid_to")
      .eq("channel", "mercadolibre")
      .eq("active", true),
    ...existingChunks,
  ])

  if (catalogResult.error) {
    throw new MercadoLibreMatchingLoadError("No se pudo leer el catálogo para vincular SKU.", catalogResult.error.message)
  }
  if (mappingsResult.error) {
    throw new MercadoLibreMatchingLoadError("No se pudieron leer los vínculos de SKU guardados.", mappingsResult.error.message)
  }
  const existingError = existingResults.find((result) => result.error)?.error
  if (existingError) {
    throw new MercadoLibreMatchingLoadError("No se pudieron consultar las ventas existentes.", existingError.message)
  }

  const catalog = (catalogResult.data ?? []) as unknown as MercadoLibreCatalogProduct[]
  const context = buildMercadoLibreMatchingContext({
    catalogTargetsBySku: buildUniqueCatalogTargetsBySku(catalog as CatalogSkuRow[]),
    catalog,
    mappings: (mappingsResult.data ?? []) as unknown as ProductChannelMapping[],
  })

  const preservedByIdentity = new Map<string, PreservedCostMapping>()
  const existingIdentities = new Set<string>()
  const pendingManualLink = new Set<string>()
  for (const result of existingResults) {
    for (const sale of (result.data ?? []) as ExistingSaleRow[]) {
      const identity = getMercadoLibreSaleIdentity({ ...sale, raw_data: sale.raw_data ?? undefined })
      existingIdentities.add(identity)
      if (sale.stock_effect === "consume" && sale.product_id == null) pendingManualLink.add(identity)
      const mapping = getPreservedCostMapping(sale)
      if (mapping) preservedByIdentity.set(identity, mapping)
    }
  }

  return { catalog, context, preservedByIdentity, existingIdentities, pendingManualLink }
}

export interface ResolvedMercadoLibreRow {
  match: MercadoLibreProductMatch | null
  preserved: PreservedCostMapping | null
  /** La venta ya existe en BEYONIX (reimportación). */
  existing: boolean
  /** Venta consume legada sin vínculo: sólo se vincula a mano. */
  pendingManualLink: boolean
}

export function resolveMercadoLibreServerRow(
  row: MercadoLibreMatchableServerRow,
  data: MatchingInput,
): ResolvedMercadoLibreRow {
  const identity = getMercadoLibreSaleIdentity(row)
  const existing = data.existingIdentities?.has(identity) ?? data.preservedByIdentity.has(identity)
  if (data.pendingManualLink?.has(identity)) {
    return { match: null, preserved: null, existing: true, pendingManualLink: true }
  }
  const preserved = data.preservedByIdentity.get(identity) ?? null
  return { match: resolveMercadoLibreProductMatch(row, data.context, preserved), preserved, existing, pendingManualLink: false }
}

/**
 * Filas listas para import_mercadolibre_sales_batch: producto y vínculo
 * resueltos en el servidor. El SKU original del reporte se conserva siempre
 * en la columna sku (y en reported_sku), aunque se haya resuelto por alias.
 */
export function buildMercadoLibreImportPayload<T extends MercadoLibreMatchableServerRow>(
  rows: T[],
  data: MatchingInput,
  options: { actorId: string; mappedAt: string },
) {
  let unlinked = 0
  // Sin vínculo y todavía inexistentes: son las que un lote consume no admite.
  let newUnlinked = 0
  const payload = rows.map((row): T & { product_id?: number; unit_cost?: number } => {
    const { match, preserved, existing } = resolveMercadoLibreServerRow(row, data)
    if (!match) {
      unlinked += 1
      if (!existing) newUnlinked += 1
      return row
    }

    // Una operación ya contabilizada conserva su imputación histórica para no
    // mover stock entre el pool genérico y una variante al reimportar.
    const mapping = preserved ?? {
      product_id: match.productId,
      variant_id: match.variantId,
      match_key: mercadoLibreMappingKey(row.sku, row.product_name),
      mapped_at: options.mappedAt,
      mapped_by: options.actorId,
      canonical_sku: normalizeMercadoLibreSku(row.sku) || undefined,
      mapping_origin: match.origin === "exact_sku" ? "automatic_exact_sku" : match.origin,
      unit_cost: 0,
    }

    return {
      ...row,
      product_id: mapping.product_id,
      unit_cost: mapping.unit_cost,
      raw_data: {
        ...row.raw_data,
        beyonix_cost_mapping: {
          product_id: mapping.product_id,
          variant_id: mapping.variant_id,
          match_key: mapping.match_key,
          mapped_at: mapping.mapped_at,
          mapped_by: mapping.mapped_by,
          canonical_sku: mapping.canonical_sku,
          mapping_origin: mapping.mapping_origin,
          ...(preserved ? {} : { mapping_id: match.mappingId, reported_sku: row.sku }),
        },
      },
    }
  })
  return { payload, unlinked, newUnlinked }
}
