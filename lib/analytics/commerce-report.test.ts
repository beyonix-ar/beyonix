import assert from "node:assert/strict"
import test from "node:test"

import { parseAddToCartPayload, parseCheckoutStartedPayload, parseSearchPayload } from "./commerce-event.ts"
import {
  abandonmentRate,
  buildCommerceReport,
  buildProductConversionReport,
  buildSearchReport,
  cartConversion,
  formatRate,
  formatRevenue,
  funnelStages,
  purchaseConversion,
  type CommercePeriod,
} from "./commerce-report.ts"
import { linkOrderAnalyticsSession } from "./order-session.ts"
import { compareRate, formatChangePoints, metricChangeDirection, metricChangeTone } from "./period-comparison.ts"
import { normalizeSearchQuery } from "./search-query.ts"

const RANGE = { from: "2026-10-21", to: "2026-10-27" }
const SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
const EVENT = "11111111-2222-4333-8444-555555555555"

const PERIOD: CommercePeriod = {
  viewedSessions: 1000, cartSessions: 260, checkoutSessions: 125,
  funnelCart: 250, funnelCheckout: 120, funnelPurchase: 60,
  purchases: 70, attributedPurchases: 60, revenue: 700_000, attributedRevenue: 600_000,
  evaluatedCarts: 240, abandonedCarts: 120, abandonedCheckouts: 60, cartsInProgress: 20,
}

test("búsqueda: normaliza (recorta, une espacios, minúsculas con tildes y ñ) y corta en 80", () => {
  assert.equal(normalizeSearchQuery("  Auriculares    BLUETOOTH  "), "auriculares bluetooth")
  assert.equal(normalizeSearchQuery("Lámpara\tÑANDÚ"), "lámpara ñandú")
  assert.equal(normalizeSearchQuery("máte"), "máte", "NFC: misma búsqueda aunque llegue descompuesta")
  assert.equal(normalizeSearchQuery("a ".repeat(60))?.length, 79, "80 caracteres sin espacio final")
  assert.equal(normalizeSearchQuery("   "), null)
  assert.equal(normalizeSearchQuery(42), null)
  assert.equal(normalizeSearchQuery("mouse gamer 2024"), "mouse gamer 2024", "números cortos (modelos, años) sí")
  assert.equal(normalizeSearchQuery("cargador 65w usb-c"), "cargador 65w usb-c")
})

test("búsqueda: no guarda texto que parezca un dato sensible", () => {
  for (const sensitive of [
    "juan.perez@gmail.com", "mi mail es ana@test.com.ar", "11 4444 5555", "+54 9 11 4444-5555", "dni 30.123.456",
    "30123456", "4509 9535 6623 3704", "0170099220000067797370", "secret_token_abcdefghijklmnopqrstuvwxyz", "https://beyonix.com/x", "www.otra-tienda.com",
  ]) {
    assert.equal(normalizeSearchQuery(sensitive), null, sensitive)
  }
})

test("payloads comerciales: tipos, UUID, ids positivos y límite de tamaño; los campos extra se ignoran", () => {
  assert.deepEqual(parseAddToCartPayload(JSON.stringify({ sessionId: SESSION.toUpperCase(), eventId: EVENT, productId: 7, variantId: 91, userId: "x", price: 1 })), {
    sessionId: SESSION, eventId: EVENT, productId: 7, variantId: 91,
  })
  assert.deepEqual(parseAddToCartPayload(JSON.stringify({ sessionId: SESSION, eventId: EVENT, productId: 7 }))?.variantId, null)
  for (const body of [
    { sessionId: SESSION, eventId: EVENT, productId: 0 },
    { sessionId: SESSION, eventId: EVENT, productId: "7" },
    { sessionId: SESSION, eventId: EVENT, productId: 7, variantId: -1 },
    { sessionId: SESSION, eventId: "no", productId: 7 },
    { sessionId: "123", eventId: EVENT, productId: 7 },
  ]) {
    assert.equal(parseAddToCartPayload(JSON.stringify(body)), null, JSON.stringify(body))
  }
  assert.equal(parseAddToCartPayload(JSON.stringify({ sessionId: SESSION, eventId: EVENT, productId: 7, pad: "x".repeat(2_000) })), null, "payload demasiado grande")
  assert.equal(parseAddToCartPayload("[]"), null)

  assert.deepEqual(parseSearchPayload(JSON.stringify({ sessionId: SESSION, eventId: EVENT, query: "  MATE  ", results: 999 })), { sessionId: SESSION, eventId: EVENT, query: "mate" }, "los resultados nunca vienen del cliente")
  assert.equal(parseSearchPayload(JSON.stringify({ sessionId: SESSION, eventId: EVENT, query: "ana@test.com" })), "skip")
  assert.equal(parseSearchPayload(JSON.stringify({ sessionId: SESSION, eventId: EVENT, query: 5 })), null)

  assert.deepEqual(parseCheckoutStartedPayload(JSON.stringify({ sessionId: SESSION, orderId: 99, total: 1 })), { sessionId: SESSION })
  assert.equal(parseCheckoutStartedPayload(JSON.stringify({})), null)
})

test("tasas: conversión a carrito, a compra y abandono; denominador 0 → — (nunca NaN)", () => {
  assert.equal(cartConversion(PERIOD), 0.25)
  assert.equal(purchaseConversion(PERIOD), 0.06)
  assert.equal(abandonmentRate(PERIOD), 0.75)
  assert.deepEqual([formatRate(0.25), formatRate(0.06), formatRate(0.0667), formatRate(1), formatRate(0), formatRate(null), formatRate(0.0001)], ["25%", "6%", "6,7%", "100%", "0%", "—", "<0,1%"])
  const empty = { ...PERIOD, viewedSessions: 0, funnelCart: 0, funnelCheckout: 0, funnelPurchase: 0, evaluatedCarts: 0, abandonedCarts: 0, abandonedCheckouts: 0 }
  assert.deepEqual([cartConversion(empty), purchaseConversion(empty), abandonmentRate(empty)], [null, null, null])
  assert.equal(formatRevenue(600_000).replace(/\s/g, " "), "$ 600.000")
})

test("funnel: cantidad, % de la etapa anterior y % del inicio", () => {
  assert.deepEqual(funnelStages(PERIOD).map((stage) => [stage.label, stage.sessions, formatRate(stage.fromPrevious), formatRate(stage.fromStart)]), [
    ["Visualización", 1000, "100%", "100%"],
    ["Carrito", 250, "25%", "25%"],
    ["Checkout", 120, "48%", "12%"],
    ["Compra", 60, "50%", "6%"],
  ])
  const empty = funnelStages({ ...PERIOD, viewedSessions: 0, funnelCart: 0, funnelCheckout: 0, funnelPurchase: 0 })
  assert.ok(empty.every((stage) => stage.sessions === 0 && stage.fromStart === null && stage.fromPrevious === null), "sin sesiones: sin porcentajes")
})

test("comparación de tasas en puntos porcentuales (8% vs 6% → +2 pp, no +33%)", () => {
  assert.deepEqual(compareRate(0.08, 0.06), { kind: "points", points: 2.0000000000000004 })
  assert.equal(formatChangePoints((0.08 - 0.06) * 100), "+2 pp")
  assert.equal(formatChangePoints(-1.84), "-1,8 pp")
  assert.deepEqual(compareRate(0.06, 0.06), { kind: "unchanged" })
  assert.deepEqual(compareRate(0.0601, 0.06), { kind: "unchanged" }, "menos de 0,05 pp")
  assert.deepEqual(compareRate(0.05, null), { kind: "new" }, "antes no había base")
  assert.deepEqual(compareRate(0, null), { kind: "unchanged" })
  assert.equal(compareRate(null, 0.05), null, "sin tasa actual no se compara")
  const up = compareRate(0.75, 0.6)!
  assert.equal(metricChangeDirection(up), "up")
  assert.equal(metricChangeTone(up, false), "negative", "abandono que sube: rojo")
  assert.equal(metricChangeTone(compareRate(0.5, 0.6)!, false), "positive")
})

test("reporte comercial: período anterior derivado; datos incoherentes quedan sin comparar", () => {
  const report = buildCommerceReport(RANGE, { current: PERIOD, previous: { ...PERIOD, funnelPurchase: 50 } })
  assert.deepEqual(report.previousRange, { from: "2026-10-14", to: "2026-10-20" })
  assert.equal(report.current, PERIOD)
  for (const broken of [
    { funnelCart: 1001 },
    { funnelPurchase: 121 },
    { attributedPurchases: 71 },
    { attributedRevenue: 700_001 },
    { abandonedCarts: 200 },
    { cartsInProgress: 21 },
    { purchases: -1 },
    { revenue: Number.NaN },
  ]) {
    assert.equal(buildCommerceReport(RANGE, { current: { ...PERIOD, ...broken }, previous: null }).current, null, JSON.stringify(broken))
  }
})

test("conversión por producto: tasas por sesiones; filas incoherentes se descartan", () => {
  const report = buildProductConversionReport(RANGE, [
    { productId: 1, name: "Auricular Legatus", slug: "legatus", image: null, available: true, viewedSessions: 120, addedSessions: 30, purchasedSessions: 8 },
    { productId: 2, name: "Raro", slug: "raro", image: null, available: true, viewedSessions: 2, addedSessions: 3, purchasedSessions: 0 },
    { productId: 3, name: "Sin vistas", slug: "x", image: null, available: false, viewedSessions: 0, addedSessions: 0, purchasedSessions: 0 },
  ])
  assert.deepEqual(report.products.map((row) => [row.name, formatRate(row.cartRate), formatRate(row.purchaseRate)]), [["Auricular Legatus", "25%", "6,7%"]])
})

test("búsquedas: totales y rankings acotados a 10", () => {
  const rows = [
    { kind: "total", term: null, searches: 120, sessions: 80 },
    ...Array.from({ length: 12 }, (_, index) => ({ kind: "top", term: `término ${index}`, searches: 20 - index, sessions: 5 })),
    { kind: "zero", term: "mouse gamer", searches: 12, sessions: 9 },
    { kind: "zero", term: "", searches: 3, sessions: 1 },
  ]
  const report = buildSearchReport(RANGE, rows)
  assert.deepEqual([report.totalSearches, report.searchSessions, report.top.length], [120, 80, 10])
  assert.deepEqual(report.withoutResults, [{ term: "mouse gamer", searches: 12 }])
  assert.deepEqual(buildSearchReport(RANGE, []), { range: RANGE, totalSearches: 0, searchSessions: 0, top: [], withoutResults: [] })
})

test("sesión ↔ orden: vincula con service_role, ignora sesiones inválidas y nunca lanza", async () => {
  const calls: unknown[] = []
  const writer = (error: { code?: string } | null, fail = false) => ({
    from: (table: "analytics_order_sessions") => ({
      upsert: async (row: { order_id: number; session_id: string }, options: { onConflict: string; ignoreDuplicates: boolean }) => {
        if (fail) throw new Error("red caída")
        calls.push([table, row, options])
        return { error }
      },
    }),
  })
  await linkOrderAnalyticsSession(writer(null), 101, SESSION.toUpperCase())
  assert.deepEqual(calls, [["analytics_order_sessions", { order_id: 101, session_id: SESSION }, { onConflict: "order_id", ignoreDuplicates: true }]])
  for (const invalid of [null, undefined, "", "no-uuid", 42]) await linkOrderAnalyticsSession(writer(null), 102, invalid)
  await linkOrderAnalyticsSession(writer(null), 0, SESSION)
  assert.equal(calls.length, 1, "sin sesión válida no se escribe nada (la orden sigue siendo compra, no atribuible)")
  await linkOrderAnalyticsSession(writer({ code: "23503" }), 103, SESSION)
  await linkOrderAnalyticsSession(writer(null, true), 104, SESSION)
})
