import type { createAdminClient } from "../supabase/admin.ts"

import { mapWithConcurrency } from "../async/map-with-concurrency.ts"
import { normalizeMercadoLibreSku } from "./sku-aliases.ts"

type AdminClient = ReturnType<typeof createAdminClient>
const READ_CONCURRENCY = 4
const UPDATE_CONCURRENCY = 8

export interface CatalogSkuRow {
  id: number
  sku: string | null
  producto_variantes: Array<{
    id: number
    sku: string | null
  }> | null
}

export interface CatalogSkuTarget {
  productId: number
  variantId: number | null
}

interface UnlinkedSaleRow {
  id: string
  sku: string | null
  raw_data: Record<string, unknown> | null
}

function rawObject(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

export function buildUniqueCatalogTargetsBySku(
  catalog: CatalogSkuRow[],
) {
  const candidates = new Map<string, CatalogSkuTarget[]>()

  const addCandidate = (sku: unknown, target: CatalogSkuTarget) => {
    const normalizedSku = normalizeMercadoLibreSku(sku)
    if (!normalizedSku) return

    const current = candidates.get(normalizedSku) ?? []
    if (
      !current.some(
        (candidate) =>
          candidate.productId === target.productId &&
          candidate.variantId === target.variantId,
      )
    ) {
      current.push(target)
    }
    candidates.set(normalizedSku, current)
  }

  catalog.forEach((product) => {
    const variants = product.producto_variantes ?? []

    if (!variants.length) {
      addCandidate(product.sku, {
        productId: product.id,
        variantId: null,
      })
    }

    variants.forEach((variant) => {
      addCandidate(variant.sku, {
        productId: product.id,
        variantId: variant.id,
      })
    })
  })

  return new Map(
    [...candidates.entries()]
      .filter(([, targets]) => targets.length === 1)
      .map(([sku, targets]) => [sku, targets[0]]),
  )
}

export async function reconcileUnlinkedMercadoLibreSalesByExactSku(
  admin: AdminClient,
  {
    sku,
    actorId,
  }: {
    sku?: string | null
    actorId?: string | null
  } = {},
) {
  const requestedSku = normalizeMercadoLibreSku(sku)
  const { data: catalogData, error: catalogError } = await admin
    .from("productos")
    .select("id, sku, producto_variantes(id, sku)")

  if (catalogError) {
    return { linked: 0, errors: [catalogError.message] }
  }

  const targetsBySku = buildUniqueCatalogTargetsBySku(
    (catalogData ?? []) as CatalogSkuRow[],
  )
  if (requestedSku && !targetsBySku.has(requestedSku)) {
    return { linked: 0, errors: [] }
  }

  const { count, error: countError } = await admin
    .from("mercadolibre_sales")
    .select("id", { count: "exact", head: true })
    .is("product_id", null)
    .not("sku", "is", null)
  if (countError) return { linked: 0, errors: [countError.message] }

  const total = count ?? 0
  const batchStarts: number[] = []
  for (let from = 0; from < total; from += 1000) batchStarts.push(from)

  const batches = await mapWithConcurrency(
    batchStarts,
    READ_CONCURRENCY,
    (from) =>
      admin
        .from("mercadolibre_sales")
        .select("id, sku, raw_data")
        .is("product_id", null)
        .not("sku", "is", null)
        .order("id", { ascending: true })
        .range(from, from + 999),
  )
  const batchError = batches.find((batch) => batch.error)?.error
  if (batchError) return { linked: 0, errors: [batchError.message] }

  const sales = batches.flatMap(
    (batch) => (batch.data ?? []) as UnlinkedSaleRow[],
  )

  const mappedAt = new Date().toISOString()
  const updates = sales.flatMap((sale) => {
    const normalizedSku = normalizeMercadoLibreSku(sale.sku)
    if (requestedSku && normalizedSku !== requestedSku) return []

    const target = targetsBySku.get(normalizedSku)
    if (!target) return []

    const rawData = rawObject(sale.raw_data)
    const storedMapping = rawObject(rawData.beyonix_cost_mapping)
    if (storedMapping.standalone_key) return []

    return [
      admin
        .from("mercadolibre_sales")
        .update({
          product_id: target.productId,
          raw_data: {
            ...rawData,
            beyonix_cost_mapping: {
              product_id: target.productId,
              variant_id: target.variantId,
              standalone_key: null,
              match_key: `sku:${normalizedSku}`,
              mapped_at: mappedAt,
              mapped_by: actorId ?? null,
              mapping_origin: "automatic_exact_sku",
            },
          },
        })
        .eq("id", sale.id)
        .is("product_id", null),
    ]
  })

  // Cada UPDATE apunta a una fila distinta (eq id) y es independiente del
  // resto: seguro correrlas en paralelo en vez de una por una.
  const results = await mapWithConcurrency(
    updates,
    UPDATE_CONCURRENCY,
    (update) => update,
  )

  let linked = 0
  const errors: string[] = []
  results.forEach((result) => {
    if (result.error) errors.push(result.error.message)
    else linked += 1
  })

  return { linked, errors }
}
