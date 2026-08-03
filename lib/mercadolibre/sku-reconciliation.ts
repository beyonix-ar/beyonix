import type { createAdminClient } from "../supabase/admin.ts"

import { normalizeMercadoLibreSku } from "./sku-aliases.ts"

type AdminClient = ReturnType<typeof createAdminClient>

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

  const sales: UnlinkedSaleRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("mercadolibre_sales")
      .select("id, sku, raw_data")
      .is("product_id", null)
      .not("sku", "is", null)
      .range(from, from + 999)

    if (error) return { linked: 0, errors: [error.message] }
    sales.push(...((data ?? []) as UnlinkedSaleRow[]))
    if (!data || data.length < 1000) break
  }

  let linked = 0
  const errors: string[] = []
  const mappedAt = new Date().toISOString()

  for (const sale of sales) {
    const normalizedSku = normalizeMercadoLibreSku(sale.sku)
    if (requestedSku && normalizedSku !== requestedSku) continue

    const target = targetsBySku.get(normalizedSku)
    if (!target) continue

    const rawData = rawObject(sale.raw_data)
    const storedMapping = rawObject(rawData.beyonix_cost_mapping)
    if (storedMapping.standalone_key) continue

    const { error } = await admin
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
      .is("product_id", null)

    if (error) {
      errors.push(error.message)
    } else {
      linked += 1
    }
  }

  return { linked, errors }
}
