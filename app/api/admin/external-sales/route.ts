import {
  EXTERNAL_SALE_COLUMNS,
  UUID_PATTERN,
  authorizeExternalSales,
  externalSalesDatabaseError,
  idempotencyKeyFrom,
  jsonError,
  normalizeSaleFields,
  readJsonObject,
  withReportedProfit,
} from "@/lib/admin/external-sales-api"

const LIST_LIMIT = 2000
const DATE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(request: Request) {
  const auth = await authorizeExternalSales(request)
  if ("error" in auth) return auth.error

  const params = new URL(request.url).searchParams
  let query = auth.admin
    .from("external_sales")
    .select(EXTERNAL_SALE_COLUMNS)
    .order("sale_date", { ascending: false })
    .order("sale_number", { ascending: false })
    .limit(LIST_LIMIT + 1)

  const from = params.get("from")
  const to = params.get("to")
  if (from && DATE.test(from)) query = query.gte("sale_date", from)
  if (to && DATE.test(to)) query = query.lte("sale_date", to)
  const channel = params.get("channel")
  if (channel === "none") query = query.is("channel", null)
  else if (channel && /^(whatsapp|instagram|direct|other)$/.test(channel)) query = query.eq("channel", channel)
  const status = params.get("status")
  if (status === "active") query = query.neq("status", "reversed")
  else if (status && /^(completed|delivered|reversed)$/.test(status)) query = query.eq("status", status)
  const stockEffect = params.get("stockEffect")
  if (stockEffect === "none" || stockEffect === "consume") query = query.eq("stock_effect", stockEffect)
  const sku = params.get("sku")?.trim()
  if (sku) query = query.ilike("sku", `%${sku.replace(/[%_\\]/g, (char) => `\\${char}`).slice(0, 120)}%`)
  const batch = params.get("batch")
  if (batch && UUID_PATTERN.test(batch)) query = query.eq("import_batch_id", batch)

  const { data, error } = await query
  if (error) return externalSalesDatabaseError(error.message)
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  return Response.json(
    { sales: rows.slice(0, LIST_LIMIT).map(withReportedProfit), truncated: rows.length > LIST_LIMIT },
    { headers: { "Cache-Control": "private, no-store" } },
  )
}

/** Alta manual. El tipo de stock (Histórica / Nueva) es obligatorio y explícito. */
export async function POST(request: Request) {
  const auth = await authorizeExternalSales(request)
  if ("error" in auth) return auth.error

  const key = idempotencyKeyFrom(request.headers.get("Idempotency-Key"))
  if (!key) return jsonError("Falta una clave de operación válida.")
  const body = await readJsonObject(request)
  if (!body) return jsonError("Los datos de la venta no son válidos.")
  if (body.stockEffect !== "none" && body.stockEffect !== "consume") {
    return jsonError("Elegí si la venta es Nueva (descuenta stock) o Histórica (no mueve stock).")
  }
  const fields = normalizeSaleFields(body, true)
  if (typeof fields === "string") return jsonError(fields)

  const productId = body.productId == null ? null : Number(body.productId)
  const variantId = body.variantId == null ? null : Number(body.variantId)
  if ((productId != null && !(Number.isInteger(productId) && productId > 0))
    || (variantId != null && !(Number.isInteger(variantId) && variantId > 0))) {
    return jsonError("El producto seleccionado no es válido.")
  }

  const { data, error } = await auth.admin.rpc("create_external_sale_idempotent", {
    p_payload: {
      ...fields,
      // Sin SKU (artículo de catálogo sin código) el producto se toma de la selección.
      ...(fields.sku ? {} : { product_id: productId, variant_id: variantId }),
      stock_effect: body.stockEffect,
    },
    p_actor_id: auth.user.id,
    p_idempotency_key: key,
  })
  if (error) return externalSalesDatabaseError(error.message)
  return Response.json({ sale: withReportedProfit(data as Record<string, unknown>) }, { status: 201 })
}
