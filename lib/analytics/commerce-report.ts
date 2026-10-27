import { previousAnalyticsRange } from "./period-comparison.ts"
import type { AnalyticsDateRange } from "./product-view-report.ts"

/**
 * Admin > Analítica > analítica comercial. Los números base los cuentan las
 * RPC (admin_commerce_funnel, admin_product_conversion, admin_search_stats);
 * acá se validan y se calculan tasas para la UI. Siempre sesiones únicas,
 * nunca eventos brutos.
 *
 * Fuente de cada etapa:
 *   * Vista, carrito, checkout: eventos del navegador validados en el servidor
 *     (product_view, add_to_cart, checkout_started).
 *   * Compra: analytics_purchases, que registra la base cuando la orden cumple
 *     la regla de "venta cobrada" del Dashboard (nunca el navegador).
 *
 * Definiciones:
 *   * Funnel: cohorte = sesiones con product_view en el período. Cada etapa
 *     cuenta las de la cohorte que llegaron a esa etapa o a una posterior, así
 *     la progresión siempre baja aunque falte un evento intermedio (por
 *     ejemplo, un checkout con un carrito armado en una sesión anterior).
 *   * Conversión a carrito / a compra: etapa / sesiones con visualización.
 *   * Compras completadas: órdenes con pago confirmado en el período, con o
 *     sin sesión. Atribuibles: las que tienen sesión de Analítica (Admin,
 *     sesión perdida u órdenes viejas no lo son). El funnel sólo usa las
 *     atribuibles.
 *   * Abandono: carrito = sesión con add_to_cart o checkout_started. Se evalúa
 *     24 h después de su última actividad de carrito/checkout (antes está "en
 *     curso"). Tasa = (carritos sin checkout + checkouts sin compra) /
 *     carritos evaluados (incluye los que compraron).
 */

export const ABANDONMENT_WINDOW_HOURS = 24

export interface CommercePeriod {
  viewedSessions: number
  cartSessions: number
  checkoutSessions: number
  funnelCart: number
  funnelCheckout: number
  funnelPurchase: number
  purchases: number
  attributedPurchases: number
  revenue: number
  attributedRevenue: number
  evaluatedCarts: number
  abandonedCarts: number
  abandonedCheckouts: number
  cartsInProgress: number
}

export interface CommerceReport {
  range: AnalyticsDateRange
  previousRange: AnalyticsDateRange
  /** `null` si la base devolvió datos incoherentes para ese período. */
  current: CommercePeriod | null
  previous: CommercePeriod | null
}

const COUNT_FIELDS = [
  "viewedSessions", "cartSessions", "checkoutSessions", "funnelCart", "funnelCheckout", "funnelPurchase",
  "purchases", "attributedPurchases", "evaluatedCarts", "abandonedCarts", "abandonedCheckouts", "cartsInProgress",
] as const

function validPeriod(period: CommercePeriod | null | undefined): CommercePeriod | null {
  if (!period) return null
  const counts = COUNT_FIELDS.every((field) => Number.isInteger(period[field]) && period[field] >= 0)
  const money = [period.revenue, period.attributedRevenue].every((value) => Number.isFinite(value) && value >= 0)
  const coherent =
    period.funnelPurchase <= period.funnelCheckout &&
    period.funnelCheckout <= period.funnelCart &&
    period.funnelCart <= period.viewedSessions &&
    period.attributedPurchases <= period.purchases &&
    period.attributedRevenue <= period.revenue + 0.005 &&
    period.abandonedCarts + period.abandonedCheckouts <= period.evaluatedCarts &&
    // Cada carrito está evaluado (viejo o con compra) o en curso, nunca en los dos.
    period.evaluatedCarts + period.cartsInProgress === period.cartSessions
  return counts && money && coherent ? period : null
}

export function buildCommerceReport(
  range: AnalyticsDateRange,
  periods: { current: CommercePeriod | null; previous: CommercePeriod | null },
): CommerceReport {
  return {
    range,
    previousRange: previousAnalyticsRange(range),
    current: validPeriod(periods.current),
    previous: validPeriod(periods.previous),
  }
}

/** Tasa 0–1, o `null` sin base (nunca NaN ni Infinity). */
export function rate(part: number, total: number): number | null {
  return total > 0 ? part / total : null
}

export const cartConversion = (period: CommercePeriod) => rate(period.funnelCart, period.viewedSessions)
export const purchaseConversion = (period: CommercePeriod) => rate(period.funnelPurchase, period.viewedSessions)
export const abandonmentRate = (period: CommercePeriod) =>
  rate(period.abandonedCarts + period.abandonedCheckouts, period.evaluatedCarts)
export const abandonedTotal = (period: CommercePeriod) => period.abandonedCarts + period.abandonedCheckouts

const rateFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 })

/** 0.25 → "25%"; 0.0667 → "6,7%"; sin base → "—". */
export function formatRate(value: number | null) {
  if (value === null) return "—"
  const percent = value * 100
  if (percent > 0 && percent < 0.05) return "<0,1%"
  return `${rateFormatter.format(percent)}%`
}

const moneyFormatter = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 })

export const formatRevenue = (value: number) => moneyFormatter.format(value)

/** Funnel de 4 etapas con % sobre la etapa anterior y sobre el inicio. */
export interface FunnelStage {
  key: "view" | "cart" | "checkout" | "purchase"
  label: string
  sessions: number
  fromPrevious: number | null
  fromStart: number | null
}

export function funnelStages(period: CommercePeriod): FunnelStage[] {
  const steps = [
    { key: "view", label: "Visualización", sessions: period.viewedSessions },
    { key: "cart", label: "Carrito", sessions: period.funnelCart },
    { key: "checkout", label: "Checkout", sessions: period.funnelCheckout },
    { key: "purchase", label: "Compra", sessions: period.funnelPurchase },
  ] as const
  return steps.map((step, index) => ({
    ...step,
    fromPrevious: index === 0 ? rate(step.sessions, step.sessions) : rate(step.sessions, steps[index - 1].sessions),
    fromStart: rate(step.sessions, period.viewedSessions),
  }))
}

// --- Conversión por producto ----------------------------------------------------

export interface ProductConversionRow {
  productId: number
  name: string
  slug: string
  image: string | null
  available: boolean
  /** Sesiones que vieron el producto (cohorte). */
  viewedSessions: number
  /** De ellas, cuántas lo agregaron al carrito. */
  addedSessions: number
  /** De ellas, cuántas lo compraron (orden con pago confirmado). */
  purchasedSessions: number
}

export interface ProductConversionEntry extends ProductConversionRow {
  cartRate: number | null
  purchaseRate: number | null
}

export interface ProductConversionReport {
  range: AnalyticsDateRange
  products: ProductConversionEntry[]
}

export function buildProductConversionReport(range: AnalyticsDateRange, rows: ProductConversionRow[]): ProductConversionReport {
  const products = rows
    .filter((row) =>
      Number.isSafeInteger(row.productId) && row.productId > 0 &&
      [row.viewedSessions, row.addedSessions, row.purchasedSessions].every((value) => Number.isInteger(value) && value >= 0) &&
      row.viewedSessions > 0 && row.addedSessions <= row.viewedSessions && row.purchasedSessions <= row.viewedSessions)
    .map((row) => ({
      ...row,
      cartRate: rate(row.addedSessions, row.viewedSessions),
      purchaseRate: rate(row.purchasedSessions, row.viewedSessions),
    }))
  return { range, products }
}

// --- Búsquedas ----------------------------------------------------------------------

export interface SearchTerm {
  term: string
  searches: number
}

export interface SearchReport {
  range: AnalyticsDateRange
  totalSearches: number
  searchSessions: number
  top: SearchTerm[]
  withoutResults: SearchTerm[]
}

export interface SearchStatsRow {
  kind: string
  term: string | null
  searches: number
  sessions: number
}

const validTerm = (row: SearchStatsRow): row is SearchStatsRow & { term: string } =>
  typeof row.term === "string" && row.term.length > 0 && Number.isInteger(row.searches) && row.searches > 0

export function buildSearchReport(range: AnalyticsDateRange, rows: SearchStatsRow[]): SearchReport {
  const total = rows.find((row) => row.kind === "total")
  const totalSearches = total && Number.isInteger(total.searches) && total.searches >= 0 ? total.searches : 0
  const searchSessions = total && Number.isInteger(total.sessions) && total.sessions >= 0 && total.sessions <= totalSearches ? total.sessions : 0
  const terms = (kind: string) =>
    rows.filter((row) => row.kind === kind).filter(validTerm).slice(0, 10).map((row) => ({ term: row.term, searches: row.searches }))
  return { range, totalSearches, searchSessions, top: terms("top"), withoutResults: terms("zero") }
}
