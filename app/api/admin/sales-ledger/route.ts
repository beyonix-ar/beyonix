import { requireInternalUser } from "@/lib/auth/admin-api"
import { canViewSensitiveNumbers } from "@/lib/auth/roles"
import {
  buildStandaloneCostItems,
  type StandaloneCostRow,
} from "@/lib/business/standalone-cost-items"

type SalesChannel = "external" | "ml"

const COMMON_SALES_COLUMNS = [
  "id",
  "sale_date",
  "product_id",
  "product_name",
  "sku",
  "quantity",
  "unit_price",
  "unit_cost",
  "gross_amount",
  "fee_amount",
  "shipping_amount",
  "other_expense_amount",
  "net_amount",
  "payment_method",
  "reference",
  "notes",
  "updated_at",
]

const EXTERNAL_SALES_COLUMNS = [...COMMON_SALES_COLUMNS, "created_at"].join(", ")
const ML_SALES_COLUMNS = [...COMMON_SALES_COLUMNS, "created_at:imported_at"].join(", ")
const EXTENDED_SALES_FIELDS = ["fee_type", "fee_value", "customer_name"]
const LEGACY_META_PREFIX = "__BEYONIX_SALE_META__"

function errorResponse(message: string, status = 400) {
  return Response.json({ error: message }, { status })
}

async function authorize(request: Request) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth
  if (!canViewSensitiveNumbers(auth.profile.rol)) {
    return { error: errorResponse("No tenés permisos para administrar ventas.", 403) }
  }
  return auth
}

function channel(value: unknown): SalesChannel | null {
  return value === "external" || value === "ml" ? value : null
}

function text(value: unknown, max: number) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, max) : null
}

function amount(value: unknown) {
  if (value === "" || value == null) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : null
}

function positiveInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function optionalPositiveInteger(value: unknown) {
  if (value === "" || value == null) return null
  return positiveInteger(value)
}

function saleDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? null : value
}

function tableFor(value: SalesChannel) {
  return value === "external" ? "external_sales" : "mercadolibre_sales"
}

function columnsFor(value: SalesChannel, extended = true) {
  const base = value === "external" ? EXTERNAL_SALES_COLUMNS : ML_SALES_COLUMNS
  return extended ? `${base}, ${EXTENDED_SALES_FIELDS.join(", ")}` : base
}

function missingExtendedColumns(message: string) {
  return /fee_type|fee_value|customer_name/i.test(message)
}

function packLegacyPayload(payload: Record<string, unknown>) {
  const next = { ...payload }
  const metadata = {
    feeType: next.fee_type === "percent" ? "percent" : "amount",
    feeValue: Number(next.fee_value ?? next.fee_amount ?? 0),
    customerName: typeof next.customer_name === "string" ? next.customer_name : null,
  }
  const notes = typeof next.notes === "string" ? next.notes : ""
  next.notes = `${LEGACY_META_PREFIX}${encodeURIComponent(JSON.stringify(metadata))}\n${notes}`
  delete next.fee_type
  delete next.fee_value
  delete next.customer_name
  return next
}

function normalizeResponseRow(row: Record<string, unknown>) {
  const rawNotes = typeof row.notes === "string" ? row.notes : ""
  if (!rawNotes.startsWith(LEGACY_META_PREFIX)) {
    return {
      ...row,
      fee_type: row.fee_type === "percent" ? "percent" : "amount",
      fee_value: Number(row.fee_value ?? row.fee_amount ?? 0),
      customer_name: row.customer_name ?? null,
    }
  }

  const [encodedMetadata, ...noteLines] = rawNotes
    .slice(LEGACY_META_PREFIX.length)
    .split("\n")
  try {
    const metadata = JSON.parse(decodeURIComponent(encodedMetadata)) as {
      feeType?: string
      feeValue?: number
      customerName?: string | null
    }
    const notes = noteLines.join("\n").trim()
    return {
      ...row,
      fee_type: metadata.feeType === "percent" ? "percent" : "amount",
      fee_value: Number(metadata.feeValue ?? row.fee_amount ?? 0),
      customer_name: metadata.customerName ?? null,
      notes: notes || null,
    }
  } catch {
    return {
      ...row,
      fee_type: "amount",
      fee_value: Number(row.fee_amount ?? 0),
      customer_name: null,
    }
  }
}

function normalizePayload(body: Record<string, unknown>, userId: string, updating = false) {
  const date = saleDate(body.saleDate)
  const productName = text(body.productName, 240)
  const productId = optionalPositiveInteger(body.productId)
  const quantity = positiveInteger(body.quantity)
  const unitPrice = amount(body.unitPrice)
  const unitCost = amount(body.unitCost)
  const feeType = body.feeType === "percent" ? "percent" : "amount"
  const feeValue = amount(body.feeValue ?? body.feeAmount)
  const shippingAmount = amount(body.shippingAmount)
  const otherExpenseAmount = amount(body.otherExpenseAmount)

  if (
    !date ||
    !productName ||
    !quantity ||
    unitPrice == null ||
    unitCost == null ||
    feeValue == null ||
    shippingAmount == null ||
    otherExpenseAmount == null
  ) {
    return { error: "Completá fecha, producto, cantidad y todos los importes con valores válidos." }
  }

  const grossAmount = Math.round(quantity * unitPrice * 100) / 100
  if (feeType === "percent" && feeValue > 100) {
    return { error: "La comisión porcentual debe estar entre 0% y 100%." }
  }
  const feeAmount =
    feeType === "percent"
      ? Math.round(grossAmount * (feeValue / 100) * 100) / 100
      : feeValue
  const netAmount =
    Math.round(
      (
        grossAmount -
        quantity * unitCost -
        feeAmount -
        shippingAmount -
        otherExpenseAmount
      ) * 100,
    ) / 100

  return {
    value: {
      sale_date: date,
      product_id: productId,
      product_name: productName,
      sku: text(body.sku, 120),
      quantity,
      unit_price: unitPrice,
      unit_cost: unitCost,
      gross_amount: grossAmount,
      fee_type: feeType,
      fee_value: feeValue,
      fee_amount: feeAmount,
      shipping_amount: shippingAmount,
      other_expense_amount: otherExpenseAmount,
      net_amount: netAmount,
      payment_method: text(body.paymentMethod, 100),
      reference: text(body.reference, 160),
      customer_name: text(body.customerName, 180),
      notes: text(body.notes, 1000),
      ...(updating
        ? { updated_by: userId, updated_at: new Date().toISOString() }
        : { created_by: userId, updated_by: userId }),
    },
  }
}

function databaseError(message: string) {
  const missingMigration = /external_sales|unit_price|unit_cost|other_expense_amount|fee_type|fee_value|customer_name|schema cache/i.test(
    message,
  )
  return errorResponse(
    /sku|created_from_costs/i.test(message)
      ? "Falta aplicar la migración 085_cost_items_shared_catalog.sql en Supabase."
      : missingMigration
        ? "Falta aplicar la migración 081_external_and_manual_sales.sql en Supabase."
      : "No se pudo completar la operación con las ventas.",
    missingMigration ? 503 : 500,
  )
}

export async function GET(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error

  const [catalogResult, productCostsResult, externalResult, mlResult] = await Promise.all([
    auth.admin
      .from("productos")
      .select("id, nombre, sku, precio, activo, producto_variantes(id, nombre, activo)")
      .order("nombre", { ascending: true }),
    auth.admin
      .from("product_cost_entries")
      .select("id, product_id, article_name, sku, quantity, total_cost, purchase_date, created_at")
      .order("purchase_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(5000),
    auth.admin
      .from("external_sales")
      .select(columnsFor("external"))
      .order("sale_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1000),
    auth.admin
      .from("mercadolibre_sales")
      .select(columnsFor("ml"))
      .order("sale_date", { ascending: false })
      .order("imported_at", { ascending: false })
      .limit(1000),
  ])

  const resolvedExternalResult =
    externalResult.error && missingExtendedColumns(externalResult.error.message)
      ? await auth.admin
          .from("external_sales")
          .select(columnsFor("external", false))
          .order("sale_date", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(1000)
      : externalResult
  const resolvedMlResult =
    mlResult.error && missingExtendedColumns(mlResult.error.message)
      ? await auth.admin
          .from("mercadolibre_sales")
          .select(columnsFor("ml", false))
          .order("sale_date", { ascending: false })
          .order("imported_at", { ascending: false })
          .limit(1000)
      : mlResult

  const error = catalogResult.error || resolvedExternalResult.error || resolvedMlResult.error
  if (error) return databaseError(error.message)

  const latestUnitCostByProduct = new Map<number, number>()
  const latestSkuByProduct = new Map<number, string>()
  const costRows = productCostsResult.error
    ? []
    : (productCostsResult.data ?? []) as StandaloneCostRow[]
  if (!productCostsResult.error) {
    for (const row of costRows) {
      const productId = Number(row.product_id)
      const quantity = Number(row.quantity)
      const totalCost = Number(row.total_cost)
      if (
        row.product_id != null &&
        Number.isInteger(productId) &&
        productId > 0 &&
        row.sku?.trim() &&
        !latestSkuByProduct.has(productId)
      ) {
        latestSkuByProduct.set(productId, row.sku.trim())
      }
      if (
        row.product_id != null &&
        Number.isInteger(productId) &&
        productId > 0 &&
        !latestUnitCostByProduct.has(productId) &&
        Number.isFinite(quantity) &&
        quantity > 0 &&
        Number.isFinite(totalCost)
      ) {
        latestUnitCostByProduct.set(
          productId,
          Math.round((totalCost / quantity) * 100) / 100,
        )
      }
    }
  }

  const storeCatalog = (catalogResult.data ?? []).map((product) => ({
    ...product,
    sku: product.sku ?? latestSkuByProduct.get(Number(product.id)) ?? null,
    unit_cost: latestUnitCostByProduct.get(Number(product.id)) ?? null,
    standalone_key: null,
  }))
  const standaloneCatalog = buildStandaloneCostItems(costRows).map((item) => ({
    id: `cost:${item.key}`,
    nombre: item.nombre,
    sku: item.sku,
    precio: 0,
    unit_cost: item.unit_cost,
    activo: true,
    standalone_key: item.key,
    producto_variantes: [],
  }))

  return Response.json({
    catalog: [...storeCatalog, ...standaloneCatalog].sort((a, b) =>
      a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }),
    ),
    externalSales: ((resolvedExternalResult.data ?? []) as unknown as Record<string, unknown>[]).map(normalizeResponseRow),
    mlSales: ((resolvedMlResult.data ?? []) as unknown as Record<string, unknown>[]).map(normalizeResponseRow),
  })
}

export async function POST(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const saleChannel = channel(body?.channel)
  if (!body || !saleChannel) return errorResponse("El canal de venta no es válido.")

  const normalized = normalizePayload(body, auth.user.id)
  if (!("value" in normalized)) {
    return errorResponse(normalized.error ?? "Los datos de la venta no son válidos.")
  }
  const normalizedValue = normalized.value as Record<string, unknown>

  const payload = (() => {
    if (saleChannel !== "ml") return normalizedValue
    const manualMlSale = { ...normalizedValue }
    delete manualMlSale.created_by
    return {
      ...manualMlSale,
      sale_date: `${String(manualMlSale.sale_date)}T12:00:00-03:00`,
      imported_by: auth.user.id,
      imported_at: new Date().toISOString(),
      raw_data: { origin: "manual" },
    }
  })()

  let result = await auth.admin
    .from(tableFor(saleChannel))
    .insert(payload)
    .select(columnsFor(saleChannel))
    .single()

  if (result.error && missingExtendedColumns(result.error.message)) {
    result = await auth.admin
      .from(tableFor(saleChannel))
      .insert(packLegacyPayload(payload))
      .select(columnsFor(saleChannel, false))
      .single()
  }
  if (result.error) return databaseError(result.error.message)
  return Response.json(
    { item: normalizeResponseRow(result.data as unknown as Record<string, unknown>) },
    { status: 201 },
  )
}

export async function PATCH(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const saleChannel = channel(body?.channel)
  const id = text(body?.id, 80)
  if (!body || !saleChannel || !id) return errorResponse("La venta indicada no es válida.")

  const normalized = normalizePayload(body, auth.user.id, true)
  if (!("value" in normalized)) {
    return errorResponse(normalized.error ?? "Los datos de la venta no son válidos.")
  }
  const normalizedValue = normalized.value as Record<string, unknown>
  const payload =
    saleChannel === "ml"
      ? {
          ...normalizedValue,
          sale_date: `${String(normalizedValue.sale_date)}T12:00:00-03:00`,
        }
      : normalizedValue

  let result = await auth.admin
    .from(tableFor(saleChannel))
    .update(payload)
    .eq("id", id)
    .select(columnsFor(saleChannel))
    .single()

  if (result.error && missingExtendedColumns(result.error.message)) {
    result = await auth.admin
      .from(tableFor(saleChannel))
      .update(packLegacyPayload(payload))
      .eq("id", id)
      .select(columnsFor(saleChannel, false))
      .single()
  }
  if (result.error) return databaseError(result.error.message)
  return Response.json({
    item: normalizeResponseRow(result.data as unknown as Record<string, unknown>),
  })
}

export async function DELETE(request: Request) {
  const auth = await authorize(request)
  if ("error" in auth) return auth.error
  const url = new URL(request.url)
  const saleChannel = channel(url.searchParams.get("channel"))
  const id = url.searchParams.get("id")
  if (!saleChannel || !id) return errorResponse("La venta indicada no es válida.")

  const { error } = await auth.admin.from(tableFor(saleChannel)).delete().eq("id", id)
  if (error) return databaseError(error.message)
  return Response.json({ success: true })
}
