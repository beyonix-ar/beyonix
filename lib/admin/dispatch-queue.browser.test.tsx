import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { chromium } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

test("Despachos: tablas, filtros y picking compactos a 390/1024/1440 px en light/dark", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-queue.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-queue-key"
  const { AdminDispatches, OrderQueueCard } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const { ProductLine } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const base = { id: 6, created_at: "2026-10-16T15:32:00-03:00", cliente_nombre: "María José Peña", estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized", total: 50000, shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, andreani_envio_id: "ENV-6", andreani_tracking: "360000001006", andreani_creation_status: "created", package: { id: 6, order_id: 6, status: "prepared" as const, attempt_number: 1, prepared_at: "2026-10-16T15:30:00Z", prepared_by: null, identification_method: "andreani" as const }, membership: null, itemCount: 2, units: 3 }
  const product = { orderItemId: 1, sku: "MT01", productName: "Mate", variantName: "Negro", orderedQuantity: 2, unitPrice: 10000 }
  const line = { order_item_id: 1, expected_sku: "MT01", expected_barcode: "7790000000001", expected_quantity: 2, scanned_quantity: 1, product_id: 1, variant_id: 1, conditioned_stock_id: null, orderedQuantity: 2, unitPrice: 10000, name: "Mate · Negro" }
  const shell = renderToStaticMarkup(<AdminDispatches />)
  const markup = `<div class="beyonix-admin-main">${shell}<div class="dispatch-surface"><table class="dispatch-orders-table"><tbody>${renderToStaticMarkup(<><OrderQueueCard item={{ ...base, package: null }} tab="armado" checked={false} onToggle={() => {}} onOpen={() => {}} /><OrderQueueCard item={base} tab="ready" checked={false} onToggle={() => {}} onOpen={() => {}} /></>)}</tbody></table><table class="dispatch-product-table"><tbody>${renderToStaticMarkup(<><ProductLine item={product} line={line} adjusted={false} /><ProductLine item={product} line={{ ...line, scanned_quantity: 2 }} adjusted={false} /></>)}</tbody></table></div></div>`
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    for (const theme of ["light", "dark"]) for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>${markup}</body></html>`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}: sin desborde`)
      assert.equal(await page.locator(".dispatch-order-row").count(), 2)
      assert.match(await page.locator(".dispatch-order-row").first().innerText(), /BX-1006[\s\S]*Pendiente[\s\S]*\$\s?50\.000/i)
      assert.match(await page.locator(".dispatch-order-row").last().innerText(), /Confirmado/i)
      assert.equal(await page.locator(".dispatch-pick-count.is-missing").innerText(), "1/2")
      assert.equal(await page.locator(".dispatch-pick-count.is-complete").innerText(), "2/2")
      assert.match(await page.locator(".dispatch-product-row").first().innerText(), /\$\s?10\.000[\s\S]*\$\s?20\.000/)
      const color = await page.locator(".dispatch-order-code").first().evaluate((element) => getComputedStyle(element).color)
      assert.equal(color, theme === "light" ? "rgb(23, 36, 51)" : "rgb(248, 250, 252)")
      const pickingColor = await page.locator(".dispatch-pick-count.is-missing").evaluate((element) => getComputedStyle(element).color)
      assert.equal(pickingColor, theme === "light" ? "rgb(185, 28, 28)" : "rgb(252, 165, 165)")
      if (width >= 640) {
        const search = await page.locator('.dispatch-filters input[type="search"]').boundingBox()
        const date = await page.locator('.dispatch-filters input[type="date"]').boundingBox()
        assert.ok(search && date && Math.abs(search.y - date.y) < 2, `${theme} ${width}: filtros alineados`)
      }
    }
  } finally { await browser.close() }
})
