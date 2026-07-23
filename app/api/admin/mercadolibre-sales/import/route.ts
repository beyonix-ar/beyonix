import { requireInternalUser } from "@/lib/auth/admin-api"

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
  const normalizedSku = String(sku ?? "").trim()
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

  let payload = rows.map((row) =>
    normalizeSale(
      {
        ...row,
        source_file_name: row.source_file_name || body.sourceFileName || null,
      },
      auth.user.id
    )
  )

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
  const productNamesWithoutSku = Array.from(
    new Set(
      payload
        .filter((row) => !row.sku)
        .map((row) => row.product_name)
        .filter(Boolean),
    ),
  )
  const mappingMatches: ExistingCostMappingRow[] = []

  for (let index = 0; index < skus.length; index += 400) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .select("sku, product_name, product_id, unit_cost, raw_data")
      .in("sku", skus.slice(index, index + 400))
    if (error) return Response.json({ error: error.message }, { status: 500 })
    mappingMatches.push(
      ...((data ?? []) as unknown as ExistingCostMappingRow[]),
    )
  }
  for (let index = 0; index < productNamesWithoutSku.length; index += 400) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .select("sku, product_name, product_id, unit_cost, raw_data")
      .in("product_name", productNamesWithoutSku.slice(index, index + 400))
    if (error) return Response.json({ error: error.message }, { status: 500 })
    mappingMatches.push(
      ...((data ?? []) as unknown as ExistingCostMappingRow[]),
    )
  }

  mappingMatches.forEach((row) => {
    const mapping = getExistingCostMapping(row)
    if (mapping) {
      preservedMappings.set(mappingKey(row.sku, row.product_name), mapping)
    }
  })

  payload = payload.map((row) => {
    const mapping = preservedMappings.get(mappingKey(row.sku, row.product_name))
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
  const existingIds: string[] = []
  for (let index = 0; index < operationIds.length; index += 400) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .select("id")
      .in("operation_id", operationIds.slice(index, index + 400))
    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }
    existingIds.push(...(data ?? []).map((row) => String(row.id)))
  }

  const insertedIds: string[] = []
  for (let index = 0; index < payload.length; index += 400) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .insert(payload.slice(index, index + 400))
      .select("id")
    if (error) {
      if (insertedIds.length) {
        await auth.admin.from("mercadolibre_sales").delete().in("id", insertedIds)
      }
      return Response.json({ error: error.message }, { status: 500 })
    }
    insertedIds.push(...(data ?? []).map((row) => String(row.id)))
  }

  for (let index = 0; index < existingIds.length; index += 400) {
    const { error } = await auth.admin
      .from("mercadolibre_sales")
      .delete()
      .in("id", existingIds.slice(index, index + 400))
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

  return Response.json({
    imported: payload.length,
    replaced: existingIds.length,
  })
}
