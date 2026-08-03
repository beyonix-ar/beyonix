import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  getCanonicalCatalogSku,
  normalizeMercadoLibreSku,
} from "@/lib/mercadolibre/sku-aliases"
import {
  buildUniqueCatalogTargetsBySku,
  type CatalogSkuRow,
} from "@/lib/mercadolibre/sku-reconciliation"
import {
  getMercadoLibreSaleIdentity,
  validateMercadoLibreImportBatch,
} from "@/lib/mercadolibre/import-integrity"

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
  id: string
  sale_date: string | null
  operation_id: string | null
  order_id: string | null
  sku: string | null
  product_name: string
  product_id: number | null
  unit_cost: number | null
  raw_data: Record<string, unknown> | null
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
  const operationIds = Array.from(
    new Set(
      payload
        .map((row) => row.operation_id)
        .filter((value): value is string => Boolean(value)),
    ),
  )
  const orderIds = Array.from(
    new Set(
      payload
        .map((row) => row.order_id)
        .filter((value): value is string => Boolean(value)),
    ),
  )
  const mappingMatches: ExistingCostMappingRow[] = []

  for (let index = 0; index < operationIds.length; index += 400) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .select("id, sale_date, operation_id, order_id, sku, product_name, product_id, unit_cost, raw_data")
      .in("operation_id", operationIds.slice(index, index + 400))
    if (error) return Response.json({ error: error.message }, { status: 500 })
    mappingMatches.push(
      ...((data ?? []) as unknown as ExistingCostMappingRow[]),
    )
  }
  for (let index = 0; index < orderIds.length; index += 400) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .select("id, sale_date, operation_id, order_id, sku, product_name, product_id, unit_cost, raw_data")
      .is("operation_id", null)
      .in("order_id", orderIds.slice(index, index + 400))
    if (error) return Response.json({ error: error.message }, { status: 500 })
    mappingMatches.push(
      ...((data ?? []) as unknown as ExistingCostMappingRow[]),
    )
  }

  mappingMatches.forEach((row) => {
    const mapping = getExistingCostMapping(row)
    if (mapping) {
      preservedMappings.set(
        getMercadoLibreSaleIdentity({
          ...row,
          raw_data: row.raw_data ?? undefined,
        }),
        mapping,
      )
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

  const catalogTargetsBySku = buildUniqueCatalogTargetsBySku(
    (catalogData ?? []) as CatalogSkuRow[],
  )

  skus.forEach((incomingSku) => {
    const canonicalSku = getCanonicalCatalogSku(incomingSku)
    const target = catalogTargetsBySku.get(canonicalSku)
    if (!target) return

    const matchKey = mappingKey(incomingSku, "")
    automaticMappings.set(matchKey, {
      product_id: target.productId,
      variant_id: target.variantId,
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
    const preservedMapping = preservedMappings.get(
      getMercadoLibreSaleIdentity(row),
    )
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
          ? "Falta aplicar la migración 20260801090000_idempotent_mercadolibre_import.sql."
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
    received: payload.length,
    inserted,
    updated,
    unchanged,
    duplicateRows,
    invalidRows: 0,
    errors: [],
    linked: payload.filter(
      (row) => "product_id" in row && row.product_id != null,
    ).length,
  })
}
