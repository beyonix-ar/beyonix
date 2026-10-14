import assert from "node:assert/strict"
import test from "node:test"

import {
  addMonths,
  buildSalesEvolution,
  countSaleOperations,
  filterCommercialSales,
  getBucketStart,
  getComparisonPeriod,
  getNiceAxis,
  getVariationPercent,
  resolveSalesPeriod,
  suggestSalesGrouping,
  type CommercialSaleLike,
} from "./dashboard-sales-analytics.ts"

const TODAY = "2026-10-14"
const NO_CUSTOM = { from: "", to: "" }

function sale(overrides: Partial<CommercialSaleLike>): CommercialSaleLike {
  return {
    id: "row-1",
    date: "2026-10-10T15:00:00.000Z",
    channel: "BEYONIX Web",
    grossAmount: 1000,
    productName: "Producto A",
    categoryName: "Categoría 1",
    orderId: "1",
    ...overrides,
  }
}

test("resuelve presets de período en hora argentina", () => {
  assert.deepEqual(resolveSalesPeriod("7d", TODAY, NO_CUSTOM, null), { from: "2026-10-08", to: TODAY })
  assert.deepEqual(resolveSalesPeriod("30d", TODAY, NO_CUSTOM, null), { from: "2026-09-15", to: TODAY })
  assert.deepEqual(resolveSalesPeriod("month", TODAY, NO_CUSTOM, null), { from: "2026-10-01", to: TODAY })
  assert.deepEqual(resolveSalesPeriod("prev-month", TODAY, NO_CUSTOM, null), { from: "2026-09-01", to: "2026-09-30" })
  assert.deepEqual(resolveSalesPeriod("year", TODAY, NO_CUSTOM, null), { from: "2026-01-01", to: TODAY })
  assert.deepEqual(resolveSalesPeriod("12m", TODAY, NO_CUSTOM, null), { from: "2025-10-15", to: TODAY })
  assert.deepEqual(resolveSalesPeriod("all", TODAY, NO_CUSTOM, "2024-03-02"), { from: "2024-03-02", to: TODAY })
  assert.deepEqual(resolveSalesPeriod("all", TODAY, NO_CUSTOM, null), { from: TODAY, to: TODAY })
})

test("el rango personalizado completa extremos vacíos y rechaza rangos invertidos", () => {
  assert.deepEqual(
    resolveSalesPeriod("custom", TODAY, { from: "2026-05-01", to: "" }, "2024-01-01"),
    { from: "2026-05-01", to: TODAY },
  )
  assert.deepEqual(
    resolveSalesPeriod("custom", TODAY, { from: "", to: "2026-02-01" }, "2024-01-01"),
    { from: "2024-01-01", to: "2026-02-01" },
  )
  assert.equal(resolveSalesPeriod("custom", TODAY, { from: "2026-05-02", to: "2026-05-01" }, null), null)
})

test("el período de comparación respeta el tramo equivalente", () => {
  assert.deepEqual(getComparisonPeriod("month", { from: "2026-10-01", to: TODAY }), { from: "2026-09-01", to: "2026-09-14" })
  assert.deepEqual(getComparisonPeriod("prev-month", { from: "2026-09-01", to: "2026-09-30" }), { from: "2026-08-01", to: "2026-08-31" })
  assert.deepEqual(getComparisonPeriod("year", { from: "2026-01-01", to: TODAY }), { from: "2025-01-01", to: "2025-10-14" })
  assert.deepEqual(getComparisonPeriod("7d", { from: "2026-10-08", to: TODAY }), { from: "2026-10-01", to: "2026-10-07" })
  assert.equal(getComparisonPeriod("all", { from: "2024-01-01", to: TODAY }), null)
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28")
})

test("sugiere agrupación según el largo del rango", () => {
  assert.equal(suggestSalesGrouping({ from: "2026-09-15", to: TODAY }), "day")
  assert.equal(suggestSalesGrouping({ from: "2026-07-16", to: TODAY }), "week")
  assert.equal(suggestSalesGrouping({ from: "2025-10-15", to: TODAY }), "month")
})

test("las semanas empiezan el lunes", () => {
  assert.equal(getBucketStart("2026-10-14", "week"), "2026-10-12")
  assert.equal(getBucketStart("2026-10-12", "week"), "2026-10-12")
  assert.equal(getBucketStart("2026-10-18", "week"), "2026-10-12")
  assert.equal(getBucketStart("2026-10-14", "month"), "2026-10-01")
})

test("la evolución es continua, separa canales y usa la fecha argentina", () => {
  const points = buildSalesEvolution(
    [
      sale({ date: "2026-10-10T15:00:00.000Z", grossAmount: 1000 }),
      sale({ date: "2026-10-10T18:00:00.000Z", channel: "MercadoLibre Marketplace", grossAmount: 500 }),
      // 01:30 UTC del 13/10 = 22:30 del 12/10 en Argentina.
      sale({ date: "2026-10-13T01:30:00.000Z", channel: "Ventas externas", grossAmount: 250 }),
      sale({ date: "2026-09-01T12:00:00.000Z", grossAmount: 9999 }),
    ],
    { from: "2026-10-10", to: "2026-10-13" },
    "day",
  )

  assert.deepEqual(points.map((point) => point.key), ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"])
  assert.deepEqual(points[0].values, { web: 1000, ml: 500, external: 0 })
  assert.equal(points[0].total, 1500)
  assert.equal(points[1].total, 0)
  assert.deepEqual(points[2].values, { web: 0, ml: 0, external: 250 })
  assert.equal(points[3].total, 0)
  assert.ok(points.every((point) => !point.partial))
})

test("agrupa por mes y marca buckets recortados como parciales", () => {
  const points = buildSalesEvolution(
    [
      sale({ date: "2026-08-20T12:00:00.000Z", grossAmount: 100 }),
      sale({ date: "2026-09-05T12:00:00.000Z", grossAmount: 200 }),
      sale({ date: "2026-10-02T12:00:00.000Z", grossAmount: 300 }),
    ],
    { from: "2026-08-15", to: TODAY },
    "month",
  )

  assert.deepEqual(points.map((point) => [point.key, point.total, point.partial]), [
    ["2026-08-01", 100, true],
    ["2026-09-01", 200, false],
    ["2026-10-01", 300, true],
  ])
  assert.equal(points[0].start, "2026-08-15")
  assert.equal(points[2].end, TODAY)
})

test("un rango inválido no genera puntos", () => {
  assert.deepEqual(buildSalesEvolution([sale({})], { from: "2026-10-14", to: "2026-10-01" }, "day"), [])
})

test("los filtros globales aplican fecha, canal, producto y categoría", () => {
  const rows = [
    sale({ id: "a" }),
    sale({ id: "b", channel: "Ventas externas" }),
    sale({ id: "c", productName: "Producto B" }),
    sale({ id: "d", categoryName: null }),
    sale({ id: "e", date: "2026-08-01T12:00:00.000Z" }),
  ]
  const ids = (filter: Parameters<typeof filterCommercialSales>[1]) =>
    filterCommercialSales(rows, filter).map((row) => row.id)

  assert.deepEqual(ids({ range: { from: "2026-10-01", to: TODAY }, channel: "todos", product: "", category: "" }), ["a", "b", "c", "d"])
  assert.deepEqual(ids({ range: null, channel: "Ventas externas", product: "", category: "" }), ["b"])
  assert.deepEqual(ids({ range: null, channel: "todos", product: "Producto B", category: "" }), ["c"])
  assert.deepEqual(ids({ range: null, channel: "todos", product: "", category: "Categoría 1" }), ["a", "b", "c", "e"])
})

test("las operaciones cuentan pedidos, no líneas de producto", () => {
  assert.equal(
    countSaleOperations([
      sale({ id: "web-1", orderId: "10" }),
      sale({ id: "web-2", orderId: "10" }),
      sale({ id: "web-3", orderId: "11" }),
      sale({ id: "ml-1", channel: "MercadoLibre Marketplace", orderId: "10" }),
      sale({ id: "ml-2", channel: "MercadoLibre Marketplace", orderId: null }),
      sale({ id: "external-1", channel: "Ventas externas", orderId: "REF" }),
      sale({ id: "external-2", channel: "Ventas externas", orderId: "REF" }),
    ]),
    6,
  )
  assert.equal(
    countSaleOperations([
      sale({ id: "web-1", orderId: "10", grossAmount: 0 }),
      sale({ id: "web-2", orderId: "10", grossAmount: 0 }),
      sale({ id: "web-3", orderId: "11", grossAmount: 0 }),
      sale({ id: "web-4", orderId: "11", grossAmount: 500 }),
    ]),
    1,
    "un pedido reintegrado por completo no cuenta como operación",
  )
})

test("el eje monetario usa escalas redondas y la variación ignora bases nulas", () => {
  assert.deepEqual(getNiceAxis(0), { max: 1, ticks: [0, 1] })
  assert.deepEqual(getNiceAxis(870_000), { max: 1_000_000, ticks: [0, 250_000, 500_000, 750_000, 1_000_000] })
  assert.deepEqual(getNiceAxis(1_250).ticks, [0, 500, 1000, 1500])
  assert.equal(getVariationPercent(150, 100), 50)
  assert.equal(getVariationPercent(150, 0), null)
})
