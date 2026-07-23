import { requireInternalUser } from "@/lib/auth/admin-api"
import { canViewSensitiveNumbers } from "@/lib/auth/roles"
import {
  buildProductCostLedgers,
  getHistoricalUnitCost,
  type ProductCostLedgerRow,
} from "@/lib/business/product-costs"

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
  product_id: number
  variant_id: number | null
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
  const productId = number(storedMapping.product_id || row.product_id)
  if (!Number.isInteger(productId) || productId <= 0) return null

  const variantId = number(storedMapping.variant_id)
  return {
    product_id: productId,
    variant_id:
      Number.isInteger(variantId) && variantId > 0 ? variantId : null,
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
      .select("id, nombre, activo, producto_variantes(id, nombre, activo)")
      .order("nombre", { ascending: true }),
    auth.admin
      .from("product_cost_entries")
      .select("product_id, variant_id, purchase_date, quantity, total_cost")
      .order("purchase_date", { ascending: true })
      .limit(10000),
  ])

  if (catalogResult.error) {
    return Response.json(
      { error: "No se pudo cargar el catálogo de productos." },
      { status: 500 },
    )
  }

  const costRows = productCostsResult.error
    ? []
    : ((productCostsResult.data ?? []) as ProductCostLedgerRow[])
  const costLedgers = buildProductCostLedgers(costRows)
  const costedRows = rows.map((row) => {
    const mapping = getCostMapping(row)
    const costableUnits = getCostableUnits(row)
    const unitCost =
      mapping && row.sale_date
        ? getHistoricalUnitCost(
            costLedgers,
            mapping.product_id,
            mapping.variant_id,
            String(row.sale_date),
          )
        : null

    return {
      ...row,
      costing: {
        match_key: row.sku
          ? `sku:${String(row.sku)}`
          : `product:${String(row.product_name ?? "")}`,
        product_id: mapping?.product_id ?? null,
        variant_id: mapping?.variant_id ?? null,
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

  return Response.json({
    rows: costedRows,
    catalog: catalogResult.data ?? [],
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
  } | null
  const matchKey = body?.matchKey?.trim() ?? ""
  const productId = Number(body?.productId ?? 0)
  const variantId = Number(body?.variantId ?? 0)
  const clearMapping = !productId

  const separator = matchKey.indexOf(":")
  const matchType = matchKey.slice(0, separator)
  const matchValue = matchKey.slice(separator + 1)
  if (
    separator < 1 ||
    !matchValue ||
    (matchType !== "sku" && matchType !== "product") ||
    (!clearMapping && (!Number.isInteger(productId) || productId <= 0)) ||
    (variantId && (!Number.isInteger(variantId) || variantId <= 0))
  ) {
    return Response.json(
      { error: "La vinculación indicada no es válida." },
      { status: 400 },
    )
  }

  if (!clearMapping) {
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

  const { data: productCosts, error: productCostsError } = clearMapping
    ? { data: [] as ProductCostLedgerRow[], error: null }
    : await auth.admin
        .from("product_cost_entries")
        .select("product_id, variant_id, purchase_date, quantity, total_cost")
        .eq("product_id", productId)
        .order("purchase_date", { ascending: true })
        .limit(10000)
  if (productCostsError) {
    return Response.json(
      { error: "No se pudieron consultar los costos del producto." },
      { status: 500 },
    )
  }

  const ledgers = buildProductCostLedgers(
    (productCosts ?? []) as ProductCostLedgerRow[],
  )
  for (const row of matchedRows) {
    const raw = { ...rawObject(row.raw_data) }
    let unitCost = 0

    if (clearMapping) {
      delete raw.beyonix_cost_mapping
    } else {
      raw.beyonix_cost_mapping = {
        product_id: productId,
        variant_id: variantId || null,
        match_key: matchKey,
        mapped_at: new Date().toISOString(),
        mapped_by: auth.user.id,
      }
      unitCost =
        getHistoricalUnitCost(
          ledgers,
          productId,
          variantId || null,
          String(row.sale_date ?? ""),
        ) ?? 0
    }

    const { error: updateError } = await auth.admin
      .from("mercadolibre_sales")
      .update({
        product_id: clearMapping ? null : productId,
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
