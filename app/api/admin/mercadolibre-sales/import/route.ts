import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  getCanonicalCatalogSku,
  normalizeMercadoLibreSku,
} from "@/lib/mercadolibre/sku-aliases"
import { validateMercadoLibreImportBatch } from "@/lib/mercadolibre/import-integrity"

interface MercadoLibreSaleInput {
  sale_date?: string | null
  operation_id?: string | null
  order_id?: string | null
  product_name?: string | null
  sku?: string | null
  quantity?: number | null
  gross_amount?: number | null
  fee_amount?: number | null
  shipping_amount?: number | null
  net_amount?: number | null
  source_file_name?: string | null
  raw_data?: Record<string, unknown>
}

interface ExistingCostMappingRow {
  source_key: string
  sku: string | null
  product_name: string
  product_id: number | null
  unit_cost: number | null
  raw_data: Record<string, unknown> | null
}

interface CatalogSkuRow {
  id: number
  sku: string | null
  producto_variantes: Array<{
    id: number
    sku: string | null
  }> | null
}

function toNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rawObject(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

function mappingKey(sku: unknown, productName: unknown) {
  const normalizedSku = normalizeMercadoLibreSku(sku)
  return normalizedSku
    ? `sku:${normalizedSku}`
    : `product:${String(productName ?? "").trim()}`
}

function sourceIdentityPart(value: unknown) {
  return encodeURIComponent(String(value ?? "").trim().toUpperCase())
}

function getSaleSourceKey(row: MercadoLibreSaleInput) {
  const raw = rawObject(row.raw_data)
  const parsed = rawObject(raw.parsed)
  const operationId =
    row.operation_id || parsed.sale_number || row.order_id || ""
  const listingId = parsed.listing_id || ""
  const variant = parsed.variant || ""
  const sku = normalizeMercadoLibreSku(row.sku || parsed.sku)

  return [
    "mercadolibre",
    sourceIdentityPart(operationId),
    sourceIdentityPart(listingId),
    sourceIdentityPart(variant),
    sourceIdentityPart(sku),
  ].join(":")
}

function getExistingCostMapping(row: ExistingCostMappingRow) {
  const raw = rawObject(row.raw_data)
  const stored = rawObject(raw.beyonix_cost_mapping)
  const productId = Number(stored.product_id ?? row.product_id ?? 0)
  if (!Number.isInteger(productId) || productId <= 0) return null

  const variantId = Number(stored.variant_id ?? 0)
  return {
    product_id: productId,
    variant_id:
      Number.isInteger(variantId) && variantId > 0 ? variantId : null,
    match_key:
      typeof stored.match_key === "string"
        ? stored.match_key
        : mappingKey(row.sku, row.product_name),
    mapped_at:
      typeof stored.mapped_at === "string" ? stored.mapped_at : undefined,
    mapped_by:
      typeof stored.mapped_by === "string" ? stored.mapped_by : undefined,
    canonical_sku:
      typeof stored.canonical_sku === "string"
        ? stored.canonical_sku
        : undefined,
    unit_cost: toNumber(row.unit_cost) ?? 0,
  }
}

function normalizeSale(row: MercadoLibreSaleInput, importedBy: string) {
  return {
    source_key: getSaleSourceKey(row),
    sale_date: row.sale_date || null,
    operation_id: row.operation_id || null,
    order_id: row.order_id || null,
    product_name: row.product_name?.trim() || "Venta MercadoLibre",
    sku: row.sku || null,
    quantity: Math.max(1, Math.trunc(toNumber(row.quantity) ?? 1)),
    unit_cost: 0,
    gross_amount: toNumber(row.gross_amount) ?? 0,
    fee_amount: toNumber(row.fee_amount),
    shipping_amount: toNumber(row.shipping_amount),
    net_amount: toNumber(row.net_amount),
    source_file_name: row.source_file_name || null,
    imported_by: importedBy,
    raw_data: row.raw_data ?? {},
  }
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as {
    rows?: MercadoLibreSaleInput[]
    sourceFileName?: string
  }
  const rows = body.rows ?? []

  if (!rows.length) {
    return Response.json(
      { error: "No hay ventas para importar." },
      { status: 400 }
    )
  }

  const normalizedRows = rows.map((row) =>
    normalizeSale(
      {
        ...row,
        source_file_name: row.source_file_name || body.sourceFileName || null,
      },
      auth.user.id
    )
  )
  let integrityResult: ReturnType<typeof validateMercadoLibreImportBatch>
  try {
    integrityResult = validateMercadoLibreImportBatch(normalizedRows)
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "El archivo contiene ventas inconsistentes.",
      },
      { status: 400 },
    )
  }
  let payload = integrityResult.rows

  const preservedMappings = new Map<
    string,
    NonNullable<ReturnType<typeof getExistingCostMapping>>
  >()
  const skus = Array.from(
    new Set(
      payload
        .map((row) => row.sku)
        .filter((value): value is string => Boolean(value)),
    ),
  )
  const sourceKeys = Array.from(new Set(payload.map((row) => row.source_key)))
  const mappingMatches: ExistingCostMappingRow[] = []

  for (let index = 0; index < sourceKeys.length; index += 400) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .select("source_key, sku, product_name, product_id, unit_cost, raw_data")
      .in("source_key", sourceKeys.slice(index, index + 400))
    if (error) return Response.json({ error: error.message }, { status: 500 })
    mappingMatches.push(
      ...((data ?? []) as unknown as ExistingCostMappingRow[]),
    )
  }

  mappingMatches.forEach((row) => {
    const mapping = getExistingCostMapping(row)
    if (mapping) {
      preservedMappings.set(row.source_key, mapping)
    }
  })

  const automaticMappings = new Map<
    string,
    NonNullable<ReturnType<typeof getExistingCostMapping>>
  >()
  const { data: catalogData, error: catalogError } = await auth.admin
    .from("productos")
    .select("id, sku, producto_variantes(id, sku)")
  if (catalogError) {
    return Response.json({ error: catalogError.message }, { status: 500 })
  }

  const catalogTargetsBySku = new Map<
    string,
    Array<{ productId: number; variantId: number | null }>
  >()
  ;((catalogData ?? []) as CatalogSkuRow[]).forEach((product) => {
    const variants = product.producto_variantes ?? []
    const productSku = normalizeMercadoLibreSku(product.sku)

    if (productSku && !variants.length) {
      catalogTargetsBySku.set(productSku, [
        ...(catalogTargetsBySku.get(productSku) ?? []),
        { productId: product.id, variantId: null },
      ])
    }

    variants.forEach((variant) => {
      const variantSku = normalizeMercadoLibreSku(variant.sku)
      if (!variantSku) return
      catalogTargetsBySku.set(variantSku, [
        ...(catalogTargetsBySku.get(variantSku) ?? []),
        { productId: product.id, variantId: variant.id },
      ])
    })
  })

  skus.forEach((incomingSku) => {
    const canonicalSku = getCanonicalCatalogSku(incomingSku)
    const targets = catalogTargetsBySku.get(canonicalSku) ?? []
    if (targets.length !== 1) return

    const matchKey = mappingKey(incomingSku, "")
    automaticMappings.set(matchKey, {
      product_id: targets[0].productId,
      variant_id: targets[0].variantId,
      match_key: matchKey,
      mapped_at: new Date().toISOString(),
      mapped_by: auth.user.id,
      canonical_sku: canonicalSku,
      unit_cost: 0,
    })
  })

  payload = payload.map((row) => {
    const key = mappingKey(row.sku, row.product_name)
    const automaticMapping = automaticMappings.get(key)
    const preservedMapping = preservedMappings.get(row.source_key)
    // Una operación ya contabilizada conserva su imputación histórica para no
    // mover stock entre el pool genérico y una variante al reimportar. Sólo
    // las operaciones nuevas usan la identidad SKU vigente del catálogo.
    const mapping = preservedMapping ?? automaticMapping
    if (!mapping) return row

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
        },
      },
    }
  })

  const operationIds = Array.from(
    new Set(
      payload
        .map((row) => row.operation_id)
        .filter((value): value is string => Boolean(value)),
    ),
  )
  const incomingSourceKeys = new Set(payload.map((row) => row.source_key))
  const existingRows: Array<{ id: string; source_key: string }> = []
  for (let index = 0; index < operationIds.length; index += 400) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .select("id, source_key")
      .in("operation_id", operationIds.slice(index, index + 400))
    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }
    existingRows.push(
      ...(data ?? []).map((row) => ({
        id: String(row.id),
        source_key: String(row.source_key),
      })),
    )
  }

  const existingIds = new Set(existingRows.map((row) => row.id))
  const insertedIds: string[] = []
  for (let index = 0; index < payload.length; index += 400) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .upsert(payload.slice(index, index + 400), {
        onConflict: "source_key",
      })
      .select("id")
    if (error) {
      const newIds = insertedIds.filter((id) => !existingIds.has(id))
      if (newIds.length) {
        await auth.admin.from("mercadolibre_sales").delete().in("id", newIds)
      }
      return Response.json({ error: error.message }, { status: 500 })
    }
    insertedIds.push(...(data ?? []).map((row) => String(row.id)))
  }

  const staleIds = existingRows
    .filter((row) => !incomingSourceKeys.has(row.source_key))
    .map((row) => row.id)
  for (let index = 0; index < staleIds.length; index += 400) {
    const { error } = await auth.admin
      .from("mercadolibre_sales")
      .delete()
      .in("id", staleIds.slice(index, index + 400))
    if (error) {
      return Response.json(
        {
          error:
            "Las ventas se importaron, pero no se pudieron reemplazar todos los registros anteriores.",
        },
        { status: 500 },
      )
    }
  }
  const { data: importResult, error: importError } = await auth.admin.rpc(
    "import_mercadolibre_sales_idempotent",
    {
      p_rows: payload,
      p_imported_by: auth.user.id,
      p_source_file_name: body.sourceFileName || null,
    },
  )

  if (importError) {
    const missingMigration =
      /import_mercadolibre_sales_idempotent|source_key|schema cache/i.test(
        importError.message,
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 106_idempotent_mercadolibre_import.sql."
          : importError.message,
      },
      { status: missingMigration ? 503 : 400 },
    )
  }

  const result = (
    importResult && typeof importResult === "object"
      ? importResult
      : {}
  ) as Record<string, unknown>
  const inserted = Number(result.inserted ?? 0)
  const updated = Number(result.updated ?? 0)
  const unchanged = Number(result.unchanged ?? 0)
  const duplicateRows =
    integrityResult.duplicateRows + Number(result.duplicate_rows ?? 0)

  return Response.json({
    imported: payload.length,
    replaced: existingRows.length,
    linked: payload.filter(
      (row) => "product_id" in row && row.product_id != null,
    ).length,
  })
}
