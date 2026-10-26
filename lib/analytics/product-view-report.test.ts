import assert from "node:assert/strict"
import test from "node:test"

import {
  buildProductViewReport,
  formatAnalyticsRange,
  formatSharePercent,
  isValidAnalyticsRange,
  resolveAnalyticsPeriod,
  type ProductViewStatsRow,
} from "./product-view-report.ts"

const TODAY = "2026-10-26"
const NO_CUSTOM = { from: "", to: "" }

test("períodos: Hoy, 7 y 30 días incluyen hoy", () => {
  assert.deepEqual(resolveAnalyticsPeriod("today", TODAY, NO_CUSTOM), { from: TODAY, to: TODAY })
  assert.deepEqual(resolveAnalyticsPeriod("7d", TODAY, NO_CUSTOM), { from: "2026-10-20", to: TODAY })
  assert.deepEqual(resolveAnalyticsPeriod("30d", TODAY, NO_CUSTOM), { from: "2026-09-27", to: TODAY })
  assert.deepEqual(resolveAnalyticsPeriod("30d", "2026-03-01", NO_CUSTOM), { from: "2026-01-31", to: "2026-03-01" }, "cruza meses")
})

test("período personalizado: hasta vacío = hoy; inválido, invertido o mayor a un año = null", () => {
  assert.deepEqual(resolveAnalyticsPeriod("custom", TODAY, { from: "2026-10-01", to: "2026-10-10" }), { from: "2026-10-01", to: "2026-10-10" })
  assert.deepEqual(resolveAnalyticsPeriod("custom", TODAY, { from: "2026-10-01", to: "" }), { from: "2026-10-01", to: TODAY })
  assert.equal(resolveAnalyticsPeriod("custom", TODAY, NO_CUSTOM), null, "sin fecha inicial")
  assert.equal(resolveAnalyticsPeriod("custom", TODAY, { from: "2026-10-10", to: "2026-10-01" }), null)
  assert.equal(resolveAnalyticsPeriod("custom", TODAY, { from: "2025-10-01", to: TODAY }), null, "más de 366 días")
  assert.equal(resolveAnalyticsPeriod("custom", TODAY, { from: "2026-02-30", to: TODAY }), null)
  assert.ok(isValidAnalyticsRange({ from: "2025-10-26", to: TODAY }), "366 días exactos")
  assert.equal(isValidAnalyticsRange({ from: "2026-10-01", to: "x" }), false)
})

const ROWS: ProductViewStatsRow[] = [
  { productId: 3, name: "Pava 12V", slug: "pava-12v", image: null, views: 95 },
  { productId: 1, name: "Auricular Malibu", slug: "auricular-malibu", image: "https://cdn.test/a.webp", views: 245 },
  { productId: 2, name: "Soporte Notebook HUB", slug: "soporte-hub", image: null, views: 180 },
  { productId: 4, name: "Lámpara Ñandú", slug: "lampara", image: null, views: 95 },
  { productId: 5, name: "Sin vistas", slug: "sin-vistas", image: null, views: 0 },
  { productId: 6, name: "Ventilador", slug: "ventilador", image: null, views: 150 },
]

test("reporte: ranking por vistas, % del total y producto más visto; nunca productos con 0", () => {
  const report = buildProductViewReport({ from: "2026-10-20", to: TODAY }, ROWS)
  assert.equal(report.totalViews, 765)
  assert.equal(report.productsViewed, 5)
  assert.deepEqual(report.ranking.map((entry) => [entry.position, entry.name, entry.views]), [
    [1, "Auricular Malibu", 245],
    [2, "Soporte Notebook HUB", 180],
    [3, "Ventilador", 150],
    [4, "Lámpara Ñandú", 95],
    [5, "Pava 12V", 95],
  ], "empate de vistas: orden alfabético en español")
  assert.equal(report.topProduct?.name, "Auricular Malibu")
  assert.ok(Math.abs(report.ranking[0].sharePercent - (245 / 765) * 100) < 1e-9)
  const totalShare = report.ranking.reduce((total, entry) => total + entry.sharePercent, 0)
  assert.ok(Math.abs(totalShare - 100) < 1e-9, "los porcentajes suman 100")
  assert.equal(formatSharePercent(report.ranking[0].sharePercent), "32%")
  assert.equal(formatSharePercent(report.ranking[1].sharePercent), "23,5%")
})

test("reporte vacío: sin vistas no hay producto más visto ni ranking", () => {
  const report = buildProductViewReport({ from: TODAY, to: TODAY }, [{ ...ROWS[4] }])
  assert.deepEqual(
    { total: report.totalViews, products: report.productsViewed, top: report.topProduct, ranking: report.ranking },
    { total: 0, products: 0, top: null, ranking: [] },
  )
})

test("formato: porcentajes y rangos en español", () => {
  assert.equal(formatSharePercent(100), "100%")
  assert.equal(formatSharePercent(12.345), "12,3%")
  assert.equal(formatSharePercent(0.01), "<0,1%")
  assert.equal(formatAnalyticsRange({ from: TODAY, to: TODAY }), "26 oct 2026")
  assert.equal(formatAnalyticsRange({ from: "2026-10-20", to: TODAY }), "20 oct – 26 oct 2026")
  assert.equal(formatAnalyticsRange({ from: "2025-12-28", to: "2026-01-03" }), "28 dic 2025 – 3 ene 2026")
})
