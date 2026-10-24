import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { chromium } from "playwright-core"

import type { LogisticsSummary } from "./logistics"
import type { LogisticsOrderRow } from "./logistics"

const summary: LogisticsSummary = {
  ordersCreated: 12, ordersSent: 9, ordersDelivered: 7, ordersReturned: 1, parcels: 15,
  soldOrders: 12, snapshotOrders: 12, chargedToCustomers: 120000, providerQuoted: 110000,
  markupCollected: 10000, roundingAdjustment: 0, benefitAbsorbed: 5000,
  parcelQuoted: 115000, parcelQuotedOrders: 10, parcelQuoteDifference: 5000,
  parcelQuoteComparableOrders: 10, comparableProviderQuoted: 110000,
  billedByAndreani: 117000, billedOutbound: 115000, billedReturnsAndExchanges: 2000,
  billedOrders: 9, billedDifferenceVsCheckout: 5000, billedDifferenceVsCheckoutOrders: 9,
  billedDifferenceVsParcel: 2000, billedDifferenceVsParcelOrders: 9,
  reconciledOrders: 6, minorDifferenceOrders: 2, majorDifferenceOrders: 1,
  noReferenceOrders: 0, pendingReconciliationOrders: 2, unmatchedEntries: 0, unmatchedAmount: 0,
  thresholds: { reconciledAmount: 100, majorAmount: 1000, majorPercent: 10 },
}

test("Logística ordena las métricas en tres bloques legibles sin desbordar desktop ni tablet", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key"
  const { LogisticsSummaryGrid } = await import("../../app/admin/sections/logistica/logistics-summary")
  const css = (await postcss([tailwindcss({ base: process.cwd() })])
    .process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const html = renderToStaticMarkup(<LogisticsSummaryGrid summary={summary} page />)
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    for (const width of [1440, 1366, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<html><head><style>${css}</style><style>body{margin:0;background:#070b12}*{box-sizing:border-box}main{padding:24px}@media(min-width:1024px){main{margin-left:260px}}</style></head><body><main>${html}</main></body></html>`)
      assert.equal(await page.locator("[data-logistics-section]").count(), 3)
      assert.deepEqual(await page.locator("[data-logistics-section]").evaluateAll((items) => items.map((item) => item.getAttribute("data-logistics-section"))), ["operational", "economics", "reconciliation"])
      assert.equal(await page.locator("[data-logistics-section='operational'] [data-logistics-metric]").count(), 5)
      assert.equal(await page.locator("[data-logistics-section='economics'] [data-logistics-metric]").count(), 6)
      assert.equal(await page.locator("[data-logistics-section='reconciliation'] [data-logistics-metric]").count(), 6)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `desborde horizontal a ${width}px`)
    }
  } finally {
    await browser.close()
  }
})

test("La fila de pedidos prioriza seguimiento y oculta el desglose técnico hasta abrir el detalle", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test-anon-key"
  const { LogisticsOrderTableRow } = await import("../../app/admin/sections/logistica/admin-logistica")
  const row: LogisticsOrderRow = {
    id: 42, code: "BX-1042", createdAt: "2026-10-01T12:00:00.000Z", tracking: "AR123", status: "Entregado",
    parcels: 2, checkoutQuote: 10000, markupPercent: 10, markupAmount: 1000, extraCharged: 1000, benefit: 500,
    chargedToCustomer: 11000, parcelQuote: 12000, difference: 2000, differencePercent: 20,
    billedOutbound: 12500, billedTotal: 12500, billedEntries: 1, billedVsCheckout: 2500,
    billedVsParcel: 500, reconciliation: "major_difference", references: "FACT-123",
  }
  const html = renderToStaticMarkup(<table><tbody><LogisticsOrderTableRow row={row} onReconcile={() => {}} /></tbody></table>)
  assert.match(html, /BX-1042/)
  assert.match(html, /AR123/)
  assert.match(html, /Ver detalle/)
  assert.match(html, /aria-expanded="false"/)
  assert.doesNotMatch(html, /Tarifa checkout|Recargo %|FACT-123|Conciliar pedido/)
  assert.equal((html.match(/<td\b/g) ?? []).length, 10)

  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const host = dom.window.document.getElementById("root")!
  const root = createRoot(host)
  try {
    await act(async () => root.render(<table><tbody><LogisticsOrderTableRow row={row} onReconcile={() => {}} /></tbody></table>))
    await act(async () => host.querySelector("button[aria-expanded='false']")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })))
    assert.match(host.textContent ?? "", /Tarifa checkout/)
    assert.match(host.textContent ?? "", /FACT-123/)
    assert.match(host.textContent ?? "", /Conciliar pedido/)
    assert.equal(host.querySelector("button[aria-expanded='true']") !== null, true)
  } finally {
    await act(async () => root.unmount())
    Object.assign(globalThis, { window: previousWindow, document: previousDocument, IS_REACT_ACT_ENVIRONMENT: false })
    dom.window.close()
  }
})
