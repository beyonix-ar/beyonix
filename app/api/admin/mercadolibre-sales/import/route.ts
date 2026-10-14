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
import {
  describeMercadoLibreImportError,
  isMissingImportMigration,
  validateMercadoLibreServerRows,
  type MercadoLibreServerRow,
} from "@/lib/mercadolibre/import-validation"

type ImportPayloadRow = MercadoLibreServerRow & { product_id?: number; unit_cost?: number }

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

const QUERY_ERROR = "No se pudieron consultar las ventas existentes. No se guardó ningún cambio de este bloque."

/**
 * Importa un bloque (≤ 500 filas) de un lote ya creado. Cada bloque es
 * atómico: o se guardan todas sus filas o ninguna. Las filas se revalidan
 * acá; el análisis del navegador nunca se toma como válido por sí solo.
 */
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  let body: { rows?: unknown; batchId?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: "El envío de ventas llegó incompleto. Volvé a intentarlo." }, { status: 400 })
  }

  const batchId = typeof body.batchId === "string" ? body.batchId : ""
  if (!UUID_PATTERN.test(batchId)) {
    return Response.json({ error: "Falta la importación a la que pertenecen estas ventas. Volvé a analizar el archivo." }, { status: 400 })
  }

  const validation = validateMercadoLibreServerRows(body.rows)
  if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 })

  let integrityResult: ReturnType<typeof validateMercadoLibreImportBatch<MercadoLibreServerRow>>
  try {
    integrityResult = validateMercadoLibreImportBatch(validation.rows)
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "El archivo contiene ventas inconsistentes." },
      { status: 400 },
    )
  }
  let payload: ImportPayloadRow[] = integrityResult.rows

  const preservedMappings = new Map<
    string,
    NonNullable<ReturnType<typeof getExistingCostMapping>>
  >()
  const skus = Array.from(
    new Set(payload.map((row) => row.sku).filter((value): value is string => Boolean(value))),
  )
  const operationIds = Array.from(new Set(payload.map((row) => row.operation_id)))
  const mappingMatches: ExistingCostMappingRow[] = []

  for (let index = 0; index < operationIds.length; index += 400) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .select("id, sale_date, operation_id, order_id, sku, product_name, product_id, unit_cost, raw_data")
      .in("operation_id", operationIds.slice(index, index + 400))
    if (error) {
      console.error("ML_IMPORT_LOOKUP_ERROR", error.message)
      return Response.json({ error: QUERY_ERROR }, { status: 500 })
    }
    mappingMatches.push(...((data ?? []) as unknown as ExistingCostMappingRow[]))
  }

  mappingMatches.forEach((row) => {
    const mapping = getExistingCostMapping(row)
    if (mapping) {
      preservedMappings.set(
        getMercadoLibreSaleIdentity({ ...row, raw_data: row.raw_data ?? undefined }),
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
    console.error("ML_IMPORT_CATALOG_ERROR", catalogError.message)
    return Response.json({ error: "No se pudo leer el catálogo para vincular SKU. No se guardó ningún cambio de este bloque." }, { status: 500 })
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
    const preservedMapping = preservedMappings.get(getMercadoLibreSaleIdentity(row))
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
    "import_mercadolibre_sales_batch",
    {
      p_batch_id: batchId,
      p_rows: payload,
      p_imported_by: auth.user.id,
    },
  )

  if (importError) {
    console.error("ML_IMPORT_RPC_ERROR", importError.message)
    const missingMigration = isMissingImportMigration(importError.message)
    return Response.json(
      {
        error: describeMercadoLibreImportError(
          importError.message,
          "No se pudo guardar este bloque de ventas. No se guardó ningún cambio de este bloque.",
        ),
      },
      { status: missingMigration ? 503 : 409 },
    )
  }

  const result = (importResult && typeof importResult === "object" ? importResult : {}) as Record<string, unknown>

  return Response.json({
    received: payload.length,
    inserted: Number(result.inserted ?? 0),
    updated: Number(result.updated ?? 0),
    unchanged: Number(result.unchanged ?? 0),
    duplicateRows: integrityResult.duplicateRows + Number(result.duplicate_rows ?? 0),
    linked: payload.filter((row) => row.product_id != null).length,
  })
}
