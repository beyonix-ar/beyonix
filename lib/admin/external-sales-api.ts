import type { SupabaseClient } from "@supabase/supabase-js"

import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  getExternalSaleMerchandiseCost,
  resolveExternalSaleReportedProfitability,
  resolveExternalSaleUnitCost,
} from "@/lib/business/external-sale-profitability"
import {
  EXTERNAL_SALE_CHANNELS,
  EXTERNAL_SALE_PAYMENT_LABELS,
  EXTERNAL_SALE_PAYMENT_METHODS,
  type ExternalSalePaymentMethod,
} from "@/lib/business/external-sales"

// Helpers server-side de Admin > Ventas externas. Toda escritura pasa por las
// RPC de 20261027210000_external_sales_imports_and_lifecycle.sql, que vuelven
// a validar rol, datos, stock y reservas dentro de la transacción.

export const EXTERNAL_SALE_COLUMNS = [
  "id", "sale_number", "sale_date", "product_id", "variant_id", "product_name", "sku", "quantity",
  "unit_price", "unit_cost", "gross_amount", "fee_amount", "shipping_amount", "other_expense_amount",
  "net_amount", "payment_method", "payment_method_code", "customer_name", "channel", "channel_label",
  "notes", "reference", "status", "stock_effect", "origin", "import_batch_id", "source_row_number",
  "declared_profit", "costo_unitario_historico", "version", "modified_after_import_at", "reversal_kind",
  "return_condition", "reversal_reason", "reversal_amount", "reversed_at", "reversed_by", "created_by",
  "updated_by", "created_at", "updated_at",
].join(", ")

const MIGRATION = "20261027210000_external_sales_imports_and_lifecycle.sql"

/** Admin y Super Admin, igual que la RPC: el operador no carga ni ve importes. */
export function authorizeExternalSales(request: Request) {
  return requireInternalUser(request, ["admin", "super_admin"])
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status })
}

function detail(message: string, prefix: string) {
  const text = message.slice(message.indexOf(prefix) + prefix.length).replace(/^:\s*/, "").trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ""
}

/** Traduce los errores de las RPC a mensajes para el administrador, sin exponer SQL. */
export function externalSalesDatabaseError(message: string | null | undefined) {
  const text = message ?? ""
  if (/FORBIDDEN|42501/.test(text)) return jsonError("No tenés permisos para administrar ventas externas.", 403)
  if (/IDEMPOTENCY_PAYLOAD_MISMATCH/.test(text)) {
    return jsonError("La operación cambió desde el primer intento. Revisá los datos y confirmá de nuevo.", 409)
  }
  if (/IDEMPOTENCY_KEY_INVALID/.test(text)) return jsonError("No se pudo identificar la operación de forma segura.")
  if (/EXTERNAL_SALE_VERSION_CONFLICT/.test(text)) {
    return jsonError("Otro administrador modificó esta venta. Recargá los datos antes de guardar.", 409)
  }
  if (/EXTERNAL_SALE_ALREADY_REVERSED/.test(text)) return jsonError("La venta ya fue anulada por otra operación.", 409)
  if (/EXTERNAL_SALE_NOT_FOUND/.test(text)) return jsonError("La venta ya no existe.", 404)
  if (/EXTERNAL_SALE_BATCH_NOT_FOUND/.test(text)) return jsonError("La tanda ya no existe.", 404)
  if (/EXTERNAL_SALE_BATCH_HAS_MODIFIED_SALES/.test(text)) {
    return jsonError("Esta tanda contiene ventas modificadas. Revisalas individualmente.", 409)
  }
  if (/EXTERNAL_SALE_BATCH_CHANGED/.test(text)) {
    return jsonError("La tanda cambió. Recargá el historial y confirmá de nuevo.", 409)
  }
  if (/EXTERNAL_SALE_STOCK_UNAVAILABLE/.test(text)) {
    return jsonError(`Stock insuficiente: ${detail(text, "EXTERNAL_SALE_STOCK_UNAVAILABLE")}`, 409)
  }
  if (/STOCK_INSUFICIENTE|INVENTORY_CORRUPTION_NEGATIVE_STOCK/.test(text)) {
    return jsonError("La venta supera el stock disponible del producto o de la variante.", 409)
  }
  if (/EXTERNAL_SALE_POSSIBLE_DUPLICATE/.test(text)) {
    return jsonError(detail(text, "EXTERNAL_SALE_POSSIBLE_DUPLICATE"), 409)
  }
  if (/EXTERNAL_SALE_STOCK_EFFECT_IMMUTABLE|EXTERNAL_SALE_SOURCE_IMMUTABLE/.test(text)) {
    return jsonError("El tipo de stock y el origen de una venta no se pueden cambiar editándola.", 409)
  }
  for (const prefix of [
    "EXTERNAL_SALE_IMPORT_INVALID_ROW", "EXTERNAL_SALE_INVALID", "EXTERNAL_SALE_IMPORT_EMPTY", "EXTERNAL_SALE_IMPORT_TOO_LARGE",
  ]) {
    if (text.includes(prefix)) return jsonError(detail(text, prefix) || "Los datos de la venta no son válidos.")
  }
  if (/schema cache|does not exist|Could not find the function|stock_effect|import_batch_id|external_sale_import_batches/i.test(text)) {
    return jsonError(`Falta aplicar la migración ${MIGRATION} en Supabase.`, 503)
  }
  return jsonError("No se pudo completar la operación con las ventas externas.", 500)
}

export async function readJsonObject(request: Request) {
  const body = (await request.json().catch(() => null)) as unknown
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

export function idempotencyKeyFrom(value: string | null | undefined) {
  const key = value?.trim()
  return key && key.length >= 8 && key.length <= 240 ? key : null
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function text(value: unknown, max: number): string | null | undefined {
  if (value == null) return null
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > max ? undefined : trimmed || null
}

function amount(value: unknown, { allowNegative = false } = {}): number | null | undefined {
  if (value == null || value === "") return null
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed) || (!allowNegative && parsed < 0) || Math.abs(parsed) > 9_999_999_999) return undefined
  return Math.round(parsed * 100) / 100
}

function positiveInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100000 ? parsed : null
}

const FIELD_MAP = {
  saleDate: "sale_date",
  customerName: "customer_name",
  channel: "channel",
  sku: "sku",
  productName: "product_name",
  quantity: "quantity",
  shippingAmount: "shipping_amount",
  paymentMethodCode: "payment_method_code",
  status: "status",
  finalPrice: "gross_amount",
  declaredProfit: "declared_profit",
  notes: "notes",
} as const

type SaleField = keyof typeof FIELD_MAP

/**
 * Normaliza los campos editables de una venta (alta o edición). Sólo incluye
 * los campos presentes en `body`; devuelve un mensaje si alguno es inválido.
 */
export function normalizeSaleFields(body: Record<string, unknown>, required: boolean): Record<string, unknown> | string {
  const out: Record<string, unknown> = {}
  const present = (field: SaleField) => Object.prototype.hasOwnProperty.call(body, field)
  if (required) {
    for (const field of ["saleDate", "quantity", "finalPrice", "channel"] as const) {
      if (!present(field)) return "Completá fecha, cantidad, precio final y canal."
    }
  }

  if (present("saleDate")) {
    if (typeof body.saleDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.saleDate)) return "La fecha de venta no es válida."
    out.sale_date = body.saleDate
  }
  if (present("quantity")) {
    const quantity = positiveInteger(body.quantity)
    if (quantity == null) return "La cantidad debe ser un entero mayor a cero."
    out.quantity = quantity
  }
  for (const [field, options] of [["finalPrice", {}], ["shippingAmount", {}], ["declaredProfit", { allowNegative: true }]] as const) {
    if (!present(field)) continue
    const value = amount(body[field], options)
    if (value === undefined) return "Revisá los importes: deben ser números válidos."
    if (field === "finalPrice" && value == null) return "Indicá el precio final."
    out[FIELD_MAP[field]] = field === "shippingAmount" ? value ?? 0 : value
  }
  for (const [field, max] of [["customerName", 180], ["sku", 120], ["productName", 240], ["notes", 1000]] as const) {
    if (!present(field)) continue
    const value = text(body[field], max)
    if (value === undefined) return "Revisá los textos: alguno es demasiado largo."
    out[FIELD_MAP[field]] = value
  }
  if (present("channel")) {
    if (!(EXTERNAL_SALE_CHANNELS as readonly unknown[]).includes(body.channel)) return "Elegí un canal válido."
    out.channel = body.channel
  }
  if (present("paymentMethodCode")) {
    const code = body.paymentMethodCode
    if (code != null && !(EXTERNAL_SALE_PAYMENT_METHODS as readonly unknown[]).includes(code)) return "Elegí un medio de pago válido."
    out.payment_method_code = code ?? null
    // El texto libre histórico se conserva; en cargas manuales se deriva del código.
    out.payment_method = code ? EXTERNAL_SALE_PAYMENT_LABELS[code as ExternalSalePaymentMethod] : null
  }
  if (present("status")) {
    if (body.status !== "completed" && body.status !== "delivered") return "El estado debe ser Confirmada o Entregada."
    out.status = body.status
  }
  return out
}

/** Ganancia mostrada en el listado: misma regla que el Dashboard. */
export function withReportedProfit<T extends Record<string, unknown>>(row: T) {
  const productId = Number(row.product_id)
  const unitCost = resolveExternalSaleUnitCost({
    productId: Number.isInteger(productId) && productId > 0 ? productId : null,
    historicalUnitCost: row.costo_unitario_historico == null ? null : Number(row.costo_unitario_historico),
    manualUnitCost: row.unit_cost,
  })
  const profitability = resolveExternalSaleReportedProfitability({
    stockEffect: row.stock_effect,
    declaredProfit: row.declared_profit,
    grossAmount: row.gross_amount,
    feeAmount: row.fee_amount,
    shippingAmount: row.shipping_amount,
    otherExpenseAmount: row.other_expense_amount,
    merchandiseCost: getExternalSaleMerchandiseCost(unitCost, row.quantity),
  })
  const publicRow: Record<string, unknown> = { ...row }
  delete publicRow.creation_request
  delete publicRow.creation_idempotency_key
  delete publicRow.content_hash
  return {
    ...publicRow,
    profit_amount: profitability.profitAmount,
    profit_source: profitability.profitSource,
    cost_amount: profitability.merchandiseCost,
    cost_status: profitability.costStatus,
  }
}

export async function profileNames(admin: SupabaseClient, ids: Array<unknown>) {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && UUID_PATTERN.test(id)))]
  const names = new Map<string, string>()
  if (!unique.length) return names
  const { data } = await admin.from("profiles").select("id, nombre, email").in("id", unique)
  for (const profile of (data ?? []) as Array<{ id: string; nombre: string | null; email: string | null }>) {
    names.set(profile.id, profile.nombre || profile.email || "Administrador")
  }
  return names
}
