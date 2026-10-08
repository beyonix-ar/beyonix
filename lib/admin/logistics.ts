import type { createAdminClient } from "@/lib/supabase/admin"
import { compareParcelQuote } from "../shipping/shipping-pricing.ts"
import { isReconciliationStatus, type ReconciliationStatus } from "./andreani-billing.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/** Argentina no tiene horario de verano: el día comercial es UTC-3. */
const ARGENTINA_OFFSET = "-03:00"
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_DAYS = 400
export const LOGISTICS_PAGE_SIZE = 50

export interface LogisticsRange {
  from: string
  to: string
  /** Límites para la base: [desde 00:00, hasta+1 00:00) en hora Argentina. */
  startIso: string
  endIso: string
}

export class LogisticsRangeError extends Error {}

function argentinaToday(now: Date) {
  return new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function isRealDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Desde/Hasta (YYYY-MM-DD). Por defecto, el mes en curso hasta hoy. */
export function parseLogisticsRange(from: string | null, to: string | null, now = new Date()): LogisticsRange {
  const today = argentinaToday(now)
  const resolvedFrom = from?.trim() || `${today.slice(0, 8)}01`
  const resolvedTo = to?.trim() || today
  if (!isRealDate(resolvedFrom) || !isRealDate(resolvedTo)) throw new LogisticsRangeError("Fechas inválidas.")
  if (resolvedFrom > resolvedTo) throw new LogisticsRangeError("La fecha Desde no puede ser posterior a Hasta.")
  const start = new Date(`${resolvedFrom}T00:00:00${ARGENTINA_OFFSET}`)
  const end = new Date(new Date(`${resolvedTo}T00:00:00${ARGENTINA_OFFSET}`).getTime() + 24 * 60 * 60 * 1000)
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
    throw new LogisticsRangeError(`El período no puede superar ${MAX_RANGE_DAYS} días.`)
  }
  return { from: resolvedFrom, to: resolvedTo, startIso: start.toISOString(), endIso: end.toISOString() }
}

export interface LogisticsSummary {
  ordersCreated: number
  ordersSent: number
  ordersDelivered: number
  ordersReturned: number
  parcels: number
  soldOrders: number
  snapshotOrders: number
  chargedToCustomers: number
  providerQuoted: number
  markupCollected: number
  roundingAdjustment: number
  benefitAbsorbed: number
  parcelQuoted: number
  parcelQuotedOrders: number
  parcelQuoteDifference: number
  parcelQuoteComparableOrders: number
  comparableProviderQuoted: number
  /** Total facturado por Andreani (todos los movimientos) de los pedidos vendidos del período. */
  billedByAndreani: number
  billedOutbound: number
  billedReturnsAndExchanges: number
  billedOrders: number
  /** Facturado (envío original) menos cotizado en checkout, en pedidos con ambos datos. */
  billedDifferenceVsCheckout: number
  billedDifferenceVsCheckoutOrders: number
  billedDifferenceVsParcel: number
  billedDifferenceVsParcelOrders: number
  reconciledOrders: number
  minorDifferenceOrders: number
  majorDifferenceOrders: number
  noReferenceOrders: number
  pendingReconciliationOrders: number
  /** Cargos facturados en el período que no se pudieron asociar a un pedido. */
  unmatchedEntries: number
  unmatchedAmount: number
  thresholds: ReconciliationThresholds
}

/** Umbrales de conciliación definidos en la base (andreani_reconciliation_thresholds). */
export interface ReconciliationThresholds {
  reconciledAmount: number
  majorAmount: number
  majorPercent: number
}

const SUMMARY_FIELDS: Array<keyof LogisticsSummary> = [
  "ordersCreated", "ordersSent", "ordersDelivered", "ordersReturned", "parcels", "soldOrders",
  "snapshotOrders", "chargedToCustomers", "providerQuoted", "markupCollected", "roundingAdjustment",
  "benefitAbsorbed", "parcelQuoted", "parcelQuotedOrders", "parcelQuoteDifference",
  "parcelQuoteComparableOrders", "comparableProviderQuoted", "billedByAndreani", "billedOutbound",
  "billedReturnsAndExchanges", "billedOrders", "billedDifferenceVsCheckout", "billedDifferenceVsCheckoutOrders",
  "billedDifferenceVsParcel", "billedDifferenceVsParcelOrders", "reconciledOrders", "minorDifferenceOrders",
  "majorDifferenceOrders", "noReferenceOrders", "pendingReconciliationOrders", "unmatchedEntries", "unmatchedAmount",
]

const finiteOr = (value: unknown, fallback: number) => {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) ? number : fallback
}

export function normalizeLogisticsSummary(value: unknown): LogisticsSummary {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const thresholds = source.thresholds && typeof source.thresholds === "object" ? (source.thresholds as Record<string, unknown>) : {}
  const numbers = Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, finiteOr(source[field], 0)])) as Omit<LogisticsSummary, "thresholds">
  return {
    ...numbers,
    thresholds: {
      reconciledAmount: finiteOr(thresholds.reconciledAmount, 0),
      majorAmount: finiteOr(thresholds.majorAmount, 0),
      majorPercent: finiteOr(thresholds.majorPercent, 0),
    },
  }
}

export async function loadLogisticsSummary(admin: AdminClient, range: LogisticsRange) {
  const { data, error } = await admin.rpc("admin_logistics_summary", { p_from: range.startIso, p_to: range.endIso })
  if (error) throw new Error("LOGISTICS_SUMMARY_FAILED")
  return normalizeLogisticsSummary(data)
}

export interface LogisticsOrderRow {
  id: number
  code: string
  createdAt: string
  tracking: string | null
  status: string
  parcels: number | null
  checkoutQuote: number | null
  markupPercent: number | null
  markupAmount: number | null
  /** Parte del envío cubierta por BEYONIX (snapshot; legacy: precio − cobrado). */
  benefit: number | null
  chargedToCustomer: number | null
  parcelQuote: number | null
  difference: number | null
  differencePercent: number | null
  /** Facturado por Andreani: envío original y total con devoluciones/cambios. Null = sin cargar. */
  billedOutbound: number | null
  billedTotal: number | null
  billedEntries: number
  /** Facturado (envío original) menos cada cotización guardada al conciliar. */
  billedVsCheckout: number | null
  billedVsParcel: number | null
  reconciliation: ReconciliationStatus
  references: string | null
}

export interface OrderReconciliationRecord {
  order_id: number
  billed_outbound: number | string | null
  billed_total: number | string | null
  entries: number
  difference_checkout: number | string | null
  difference_parcel: number | string | null
  status: string
  references_list: string | null
}

interface OrderLogisticsRecord {
  id: number
  created_at: string
  estado: string
  andreani_estado: string | null
  andreani_tracking: string | null
  tracking_number: string | null
  shipping_provider_quote_amount: number | string | null
  shipping_markup_percent: number | string | null
  shipping_markup_amount: number | string | null
  shipping_cost_charged: number | string | null
  shipping_cost_real: number | string | null
  shipping_benefit_amount: number | string | null
  shipping_parcel_quote_status: string | null
  shipping_parcel_quote_amount: number | string | null
}

const amount = (value: number | string | null) => value === null || value === undefined ? null : Number(value)

export function toLogisticsOrderRow(record: OrderLogisticsRecord, parcels: number | null, billing: OrderReconciliationRecord | null = null): LogisticsOrderRow {
  const checkoutQuote = amount(record.shipping_provider_quote_amount)
  const parcelQuote = record.shipping_parcel_quote_status === "quoted" ? amount(record.shipping_parcel_quote_amount) : null
  const charged = amount(record.shipping_cost_charged)
  const logisticsPrice = amount(record.shipping_cost_real)
  const comparison = parcelQuote !== null && checkoutQuote !== null
    ? compareParcelQuote(Math.round(checkoutQuote * 100), Math.round(parcelQuote * 100))
    : null
  return {
    id: record.id,
    code: `BX-${1000 + record.id}`,
    createdAt: record.created_at,
    tracking: record.andreani_tracking ?? record.tracking_number ?? null,
    status: record.andreani_estado || record.estado,
    parcels,
    checkoutQuote,
    markupPercent: amount(record.shipping_markup_percent),
    markupAmount: amount(record.shipping_markup_amount),
    benefit: amount(record.shipping_benefit_amount) ??
      (logisticsPrice !== null && charged !== null ? Math.max(0, Math.round((logisticsPrice - charged) * 100) / 100) : null),
    chargedToCustomer: charged,
    parcelQuote,
    difference: comparison ? comparison.differenceCents / 100 : null,
    differencePercent: comparison?.differencePercent ?? null,
    billedOutbound: amount(billing?.billed_outbound ?? null),
    billedTotal: amount(billing?.billed_total ?? null),
    billedEntries: Number(billing?.entries ?? 0),
    billedVsCheckout: amount(billing?.difference_checkout ?? null),
    billedVsParcel: amount(billing?.difference_parcel ?? null),
    reconciliation: isReconciliationStatus(billing?.status) ? billing.status : "pending",
    references: billing?.references_list ?? null,
  }
}

const ORDER_COLUMNS = "id,created_at,estado,andreani_estado,andreani_tracking,tracking_number,shipping_provider_quote_amount,shipping_markup_percent,shipping_markup_amount,shipping_cost_charged,shipping_cost_real,shipping_benefit_amount,shipping_parcel_quote_status,shipping_parcel_quote_amount"

export async function loadLogisticsOrders(admin: AdminClient, range: LogisticsRange, page: number) {
  const offset = (page - 1) * LOGISTICS_PAGE_SIZE
  const { data, error, count } = await admin
    .from("ordenes")
    .select(ORDER_COLUMNS, { count: "exact" })
    .or("shipping_provider.eq.andreani,envio_proveedor.eq.andreani")
    .gte("created_at", range.startIso)
    .lt("created_at", range.endIso)
    .order("created_at", { ascending: false })
    .range(offset, offset + LOGISTICS_PAGE_SIZE - 1)
  if (error) throw new Error("LOGISTICS_ORDERS_FAILED")
  const records = (data ?? []) as unknown as OrderLogisticsRecord[]
  const ids = records.map((record) => record.id)
  const parcelsByOrder = new Map<number, number>()
  const billingByOrder = new Map<number, OrderReconciliationRecord>()
  if (ids.length) {
    const [packages, reconciliation] = await Promise.all([
      admin.from("order_packages").select("order_id,parcel_count").in("order_id", ids),
      admin.rpc("andreani_order_reconciliation", { p_order_ids: ids }),
    ])
    if (packages.error || reconciliation.error) throw new Error("LOGISTICS_ORDERS_FAILED")
    for (const row of packages.data ?? []) {
      if (row.parcel_count) parcelsByOrder.set(Number(row.order_id), Number(row.parcel_count))
    }
    for (const row of (reconciliation.data ?? []) as OrderReconciliationRecord[]) billingByOrder.set(Number(row.order_id), row)
  }
  return {
    rows: records.map((record) => toLogisticsOrderRow(record, parcelsByOrder.get(record.id) ?? null, billingByOrder.get(record.id) ?? null)),
    total: count ?? records.length,
    pageSize: LOGISTICS_PAGE_SIZE,
  }
}
