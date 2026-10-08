import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  LogisticsRangeError,
  normalizeLogisticsSummary,
  parseLogisticsRange,
  toLogisticsOrderRow,
} from "./logistics.ts"

test("período por defecto: mes en curso en hora Argentina, hasta fin del día de hoy", () => {
  // 2026-10-01 01:30 UTC = 30/09 22:30 en Argentina: todavía es septiembre.
  const range = parseLogisticsRange(null, null, new Date("2026-10-01T01:30:00Z"))
  assert.deepEqual([range.from, range.to], ["2026-09-01", "2026-09-30"])
  assert.equal(range.startIso, "2026-09-01T03:00:00.000Z")
  assert.equal(range.endIso, "2026-10-01T03:00:00.000Z")
})

test("Desde/Hasta se validan: fechas reales, orden y período máximo", () => {
  assert.deepEqual(parseLogisticsRange("2026-10-01", "2026-10-07").from, "2026-10-01")
  for (const [from, to] of [["2026-02-30", "2026-03-01"], ["2026-10-08", "2026-10-01"], ["ayer", "hoy"], ["2024-01-01", "2026-01-01"]]) {
    assert.throws(() => parseLogisticsRange(from, to), LogisticsRangeError)
  }
})

test("fila de logística: diferencia checkout vs bulto real y conciliación pendiente sin factura", () => {
  const record = {
    id: 31, created_at: "2026-10-07T15:00:00Z", estado: "pagado", andreani_estado: null,
    andreani_tracking: "360000101651699", tracking_number: null,
    shipping_provider_quote_amount: "10000.00", shipping_markup_percent: "5.00", shipping_markup_amount: "500.00",
    shipping_cost_charged: "8000.00", shipping_cost_real: "10500.00", shipping_benefit_amount: "2500.00",
    shipping_parcel_quote_status: "quoted", shipping_parcel_quote_amount: "10380.00",
  }
  const row = toLogisticsOrderRow(record, 2)
  assert.equal(row.code, "BX-1031")
  assert.equal(row.difference, 380)
  assert.equal(row.differencePercent, 3.8)
  assert.equal(row.benefit, 2_500)
  assert.equal(row.markupAmount, 500)
  assert.equal(row.parcels, 2)
  assert.equal(row.billedOutbound, null, "sin factura cargada no hay 'real'")
  assert.equal(row.reconciliation, "pending")
  // Con cargos: el estado y las diferencias vienen calculados por la base.
  const billed = toLogisticsOrderRow(record, 2, {
    order_id: 31, billed_outbound: "10900.00", billed_total: "18800.00", entries: 2,
    difference_checkout: "900.00", difference_parcel: "520.00", status: "major_difference", references_list: "A-0001-00001234",
  })
  assert.deepEqual([billed.billedOutbound, billed.billedTotal, billed.billedVsCheckout, billed.billedVsParcel, billed.reconciliation, billed.references],
    [10_900, 18_800, 900, 520, "major_difference", "A-0001-00001234"])
  // Un estado desconocido nunca se muestra como conciliado.
  assert.equal(toLogisticsOrderRow(record, null, { order_id: 31, billed_outbound: null, billed_total: null, entries: 0,
    difference_checkout: null, difference_parcel: null, status: "otro", references_list: null }).reconciliation, "pending")
  const failed = toLogisticsOrderRow({ ...record, id: 32, andreani_tracking: null, shipping_provider_quote_amount: null,
    shipping_markup_percent: null, shipping_markup_amount: null, shipping_cost_charged: "9000", shipping_cost_real: "12000",
    shipping_benefit_amount: null, shipping_parcel_quote_status: "failed", shipping_parcel_quote_amount: null }, null)
  assert.equal(failed.parcelQuote, null)
  assert.equal(failed.difference, null)
  assert.equal(failed.benefit, 3_000, "legacy: precio logístico − cobrado")
})

test("resumen: números de la base normalizados; nunca NaN", () => {
  const summary = normalizeLogisticsSummary({ markupCollected: "1370", providerQuoted: 37000, parcels: "x" })
  assert.equal(summary.markupCollected, 1_370)
  assert.equal(summary.providerQuoted, 37_000)
  assert.equal(summary.parcels, 0)
  assert.equal(summary.billedOrders, 0)
  assert.deepEqual(summary.thresholds, { reconciledAmount: 0, majorAmount: 0, majorPercent: 0 })
  const withThresholds = normalizeLogisticsSummary({ thresholds: { reconciledAmount: 100, majorAmount: "500", majorPercent: 5 }, majorDifferenceOrders: 2 })
  assert.deepEqual(withThresholds.thresholds, { reconciledAmount: 100, majorAmount: 500, majorPercent: 5 })
  assert.equal(withThresholds.majorDifferenceOrders, 2)
})

test("Logística es sólo Admin: la API exige admin/super_admin y la ruta no es operativa", () => {
  const api = readFileSync(new URL("../../app/api/admin/logistics/route.ts", import.meta.url), "utf8")
  assert.match(api, /const ROLES = \["admin", "super_admin"\]/)
  const routes = readFileSync(new URL("./admin-routes.ts", import.meta.url), "utf8")
  assert.match(routes, /logistica: "\/admin\/logistica"/)
  assert.doesNotMatch(routes.match(/OPERATOR_ROUTES = new Set<AdminRouteKey>\(\[[\s\S]*?\]\)/)?.[0] ?? "", /logistica/)
})
