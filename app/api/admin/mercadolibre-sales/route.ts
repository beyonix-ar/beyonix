import { requireInternalUser } from "@/lib/auth/admin-api"
import { canViewSensitiveNumbers } from "@/lib/auth/roles"
import {
  buildProductCostLedgers,
  getHistoricalUnitCost,
  type ProductCostLedgerRow,
} from "@/lib/business/product-costs"
import {
  buildStandaloneCostItems,
  getStandaloneHistoricalUnitCost,
  standaloneCostKey,
  type StandaloneCostRow,
} from "@/lib/business/standalone-cost-items"

const SELECT = [
  "id",
  "sale_date",
  "operation_id",
  "order_id",
  "product_id",
  "product_name",
  "sku",
  "quantity",
  "unit_cost",
  "gross_amount",
  "fee_amount",
  "shipping_amount",
  "net_amount",
  "source_file_name",
  "imported_at",
  "raw_data",
].join(", ")

interface CostMapping {
  product_id: number | null
  variant_id: number | null
  standalone_key: string | null
  match_key: string
}

function number(value: unknown) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizedText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
}

function rawObject(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

function getCostMapping(row: Record<string, unknown>): CostMapping | null {
  const raw = rawObject(row.raw_data)
  const storedMapping = rawObject(raw.beyonix_cost_mapping)
  const standaloneKey =
    typeof storedMapping.standalone_key === "string"
      ? storedMapping.standalone_key
      : null
  const productId = number(storedMapping.product_id || row.product_id)
  const validProductId = Number.isInteger(productId) && productId > 0
    ? productId
    : null
  if (!validProductId && !standaloneKey) return null

  const variantId = number(storedMapping.variant_id)
  return {
    product_id: validProductId,
    variant_id:
      validProductId && Number.isInteger(variantId) && variantId > 0 ? variantId : null,
    standalone_key: standaloneKey,
    match_key:
      typeof storedMapping.match_key === "string"
        ? storedMapping.match_key
        : row.sku
          ? `sku:${String(row.sku)}`
          : `product:${String(row.product_name ?? "")}`,
  }
}

function getCostableUnits(row: Record<string, unknown>) {
  const quantity = Math.max(0, Math.trunc(number(row.quantity)))
  const parsed = rawObject(rawObject(row.raw_data).parsed)
  const status = normalizedText(parsed.status)
  const cancelled = status.includes("cancel") || status.includes("anulad")
  if (cancelled) return 0

  const returned =
    status.includes("devol") ||
    status.includes("reembolso") ||
    number(parsed.cancellations_refunds) < 0 ||
    Boolean(String(parsed.return_tracking_number ?? "").trim()) ||
    Boolean(String(parsed.return_result ?? "").trim())
  const reportedReturnedUnits = Math.max(
    0,
    Math.trunc(number(parsed.return_units)),
  )
  const returnedUnits = returned
    ? reportedReturnedUnits || quantity
    : reportedReturnedUnits

  return Math.max(0, quantity - Math.min(quantity, returnedUnits))
}

async function authorize(request: Request) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth
  if (!canViewSensitiveNumbers(auth.profile.rol)) {
    return {
      error: Response.json(
        { error: "No tenés permisos para consultar ventas de Mercado Libre." },
        { status: 403 },
      ),
    }
  }
  return auth
}

export async function GET(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error

  const rows: Record<string, unknown>[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await auth.admin
      .from("mercadolibre_sales")
      .select(SELECT)
      .order("sale_date", { ascending: false })
      .order("imported_at", { ascending: false })
      .range(from, from + 999)
    if (error) {
      return Response.json(
        { error: "No se pudieron cargar las ventas de Mercado Libre." },
        { status: 500 },
      )
    }
    rows.push(...((data ?? []) as unknown as Record<string, unknown>[]))
    if (!data || data.length < 1000) break
  }

  const [catalogResult, productCostsResult] = await Promise.all([
    auth.admin
      .from("productos")
      .select("id, nombre, sku, activo, producto_variantes(id, nombre, activo)")
      .order("nombre", { ascending: true }),
    auth.admin
      .from("product_cost_entries")
      .select("id, product_id, variant_id, article_name, sku, purchase_date, quantity, total_cost, created_at")
      .order("purchase_date", { ascending: true })
      .limit(10000),
  ])

  if (catalogResult.error) {
    return Response.json(
      {
        error: /sku|created_from_costs|schema cache/i.test(catalogResult.error.message)
          ? "Falta aplicar la migración 085_cost_items_shared_catalog.sql en Supabase."
          : "No se pudo cargar el catálogo de productos.",
      },
      { status: /sku|created_from_costs|schema cache/i.test(catalogResult.error.message) ? 503 : 500 },
    )
  }

  const allCostRows = productCostsResult.error
    ? []
    : ((productCostsResult.data ?? []) as (ProductCostLedgerRow & StandaloneCostRow)[])
  const costLedgers = buildProductCostLedgers(allCostRows)
  const costedRows = rows.map((row) => {
    const mapping = getCostMapping(row)
    const costableUnits = getCostableUnits(row)
    const unitCost = mapping && row.sale_date
      ? mapping.standalone_key
        ? getStandaloneHistoricalUnitCost(
            allCostRows,
            mapping.standalone_key,
            String(row.sale_date),
          )
        : mapping.product_id
          ? getHistoricalUnitCost(
              costLedgers,
              mapping.product_id,
              mapping.variant_id,
              String(row.sale_date),
            )
          : null
      : null

    return {
      ...row,
      costing: {
        match_key: row.sku
          ? `sku:${String(row.sku)}`
          : `product:${String(row.product_name ?? "")}`,
        product_id: mapping?.product_id ?? null,
        variant_id: mapping?.variant_id ?? null,
        standalone_key: mapping?.standalone_key ?? null,
        costable_units: costableUnits,
        unit_cost: unitCost,
        merchandise_cost:
          costableUnits === 0
            ? 0
            : unitCost == null
              ? null
              : Math.round(unitCost * costableUnits * 100) / 100,
      },
    }
  })

  const standaloneCatalog = buildStandaloneCostItems(allCostRows).map((item) => ({
    id: `cost:${item.key}`,
    nombre: item.nombre,
    sku: item.sku,
    activo: true,
    standalone_key: item.key,
    producto_variantes: [],
  }))
  const latestSkuByProduct = new Map<number, string>()
  allCostRows.forEach((row) => {
    if (row.product_id != null && row.sku?.trim()) {
      latestSkuByProduct.set(row.product_id, row.sku.trim())
    }
  })
  const catalog = [
    ...(catalogResult.data ?? []).map((product) => ({
      ...product,
      sku: product.sku ?? latestSkuByProduct.get(Number(product.id)) ?? null,
      standalone_key: null,
    })),
    ...standaloneCatalog,
  ].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }))

  return Response.json({
    rows: costedRows,
    catalog,
    costingError: productCostsResult.error
      ? "No se pudieron consultar los costos históricos de los productos."
      : null,
  })
}

export async function PATCH(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as {
    matchKey?: string
    productId?: number | null
    variantId?: number | null
    standaloneKey?: string | null
  } | null
  const matchKey = body?.matchKey?.trim() ?? ""
  const productId = Number(body?.productId ?? 0)
  const variantId = Number(body?.variantId ?? 0)
  const standaloneKey = body?.standaloneKey?.trim() || null
  const clearMapping = !productId && !standaloneKey

  const separator = matchKey.indexOf(":")
  const matchType = matchKey.slice(0, separator)
  const matchValue = matchKey.slice(separator + 1)
  if (
    separator < 1 ||
    !matchValue ||
    (matchType !== "sku" && matchType !== "product") ||
    (!clearMapping && !standaloneKey && (!Number.isInteger(productId) || productId <= 0)) ||
    (standaloneKey != null && !/^(sku|name):.+/.test(standaloneKey)) ||
    (variantId && (!Number.isInteger(variantId) || variantId <= 0))
  ) {
    return Response.json(
      { error: "La vinculación indicada no es válida." },
      { status: 400 },
    )
  }

  if (!clearMapping && !standaloneKey) {
    const { data: product, error: productError } = await auth.admin
      .from("productos")
      .select("id")
      .eq("id", productId)
      .maybeSingle()
    if (productError || !product) {
      return Response.json(
        { error: "El producto seleccionado ya no está disponible." },
        { status: 400 },
      )
    }

    if (variantId) {
      const { data: variant, error: variantError } = await auth.admin
        .from("producto_variantes")
        .select("id")
        .eq("id", variantId)
        .eq("producto_id", productId)
        .maybeSingle()
      if (variantError || !variant) {
        return Response.json(
          { error: "La variante seleccionada no pertenece al producto." },
          { status: 400 },
        )
      }
    }
  }

  let matchedRowsQuery = auth.admin
    .from("mercadolibre_sales")
    .select("id, sale_date, product_id, product_name, sku, quantity, raw_data")
  matchedRowsQuery =
    matchType === "sku"
      ? matchedRowsQuery.eq("sku", matchValue)
      : matchedRowsQuery.eq("product_name", matchValue)
  const { data: matchedRows, error: matchedRowsError } = await matchedRowsQuery

  if (matchedRowsError) {
    return Response.json(
      { error: "No se pudieron encontrar las ventas de esa publicación." },
      { status: 500 },
    )
  }
  if (!matchedRows?.length) {
    return Response.json(
      { error: "No se encontraron ventas para vincular." },
      { status: 404 },
    )
  }

  let productCostsQuery = auth.admin
    .from("product_cost_entries")
    .select("id, product_id, variant_id, article_name, sku, purchase_date, quantity, total_cost, created_at")
    .order("purchase_date", { ascending: true })
    .limit(10000)
  if (standaloneKey) {
    productCostsQuery = productCostsQuery.is("product_id", null)
  } else if (productId) {
    productCostsQuery = productCostsQuery.eq("product_id", productId)
  }
  const { data: productCosts, error: productCostsError } = clearMapping
    ? { data: [] as ProductCostLedgerRow[], error: null }
    : await productCostsQuery
  if (productCostsError) {
    return Response.json(
      { error: "No se pudieron consultar los costos del producto." },
      { status: 500 },
    )
  }

  const selectedCostRows = (
    (productCosts ?? []) as unknown as (ProductCostLedgerRow & StandaloneCostRow)[]
  ).filter((row) => !standaloneKey || standaloneCostKey(row) === standaloneKey)
  if (!clearMapping && standaloneKey && !selectedCostRows.length) {
    return Response.json(
      { error: "El artículo de Costos reales seleccionado ya no está disponible." },
      { status: 400 },
    )
  }
  const ledgers = buildProductCostLedgers(selectedCostRows)
  for (const row of matchedRows) {
    const raw = { ...rawObject(row.raw_data) }
    let unitCost = 0

    if (clearMapping) {
      delete raw.beyonix_cost_mapping
    } else {
      raw.beyonix_cost_mapping = {
        product_id: standaloneKey ? null : productId,
        variant_id: variantId || null,
        standalone_key: standaloneKey,
        match_key: matchKey,
        mapped_at: new Date().toISOString(),
        mapped_by: auth.user.id,
      }
      unitCost = standaloneKey
        ? getStandaloneHistoricalUnitCost(
            selectedCostRows,
            standaloneKey,
            String(row.sale_date ?? ""),
          ) ?? 0
        : getHistoricalUnitCost(
            ledgers,
            productId,
            variantId || null,
            String(row.sale_date ?? ""),
          ) ?? 0
    }

    const { error: updateError } = await auth.admin
      .from("mercadolibre_sales")
      .update({
        product_id: clearMapping || standaloneKey ? null : productId,
        unit_cost: Math.round(unitCost * 100) / 100,
        raw_data: raw,
      })
      .eq("id", row.id)
    if (updateError) {
      return Response.json(
        { error: "No se pudo guardar la vinculación de costos." },
        { status: 500 },
      )
    }
  }

  return Response.json({ success: true, updated: matchedRows.length })
}

export async function DELETE(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error
  const id = new URL(request.url).searchParams.get("id")
  if (!id) {
    return Response.json({ error: "La venta indicada no es válida." }, { status: 400 })
  }

  const { error } = await auth.admin.from("mercadolibre_sales").delete().eq("id", id)
  if (error) {
    return Response.json(
      { error: "No se pudo eliminar la venta de Mercado Libre." },
      { status: 500 },
    )
  }
  return Response.json({ success: true })
}
