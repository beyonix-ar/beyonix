import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { chromium } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

test("control final: tabla legible sin navegación ni desborde en 390, 430 y 1024 px, light/dark", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-browser.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-browser-key"
  const { MobileBundleView } = await import("../../app/admin/despachos/bultos/[id]/control/mobile-bundle-control")
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const batch = { id: 47, code: "DSP-20261018-001", display_number: 1, status: "closed" as const, created_at: "2026-10-18T12:00:00Z", closed_at: "2026-10-18T12:00:00Z", handed_over_at: null, handed_over_by: null }
  const markup = renderToStaticMarkup(<MobileBundleView detail={{ batch, name: 1, items: [
    { orderId: 9, status: "CORRECTO", blocked: false, hold: null },
    { orderId: 10, status: "CANCELADO", blocked: true, hold: { id: 1, orderId: 10, units: 1, pickedUnits: 1, prepared: true, itemCount: 1, detectedAt: batch.created_at, batchId: 47, batchCode: batch.code } },
  ], removedOrderIds: [11], parcelCount: 1 }} busy={false} error="" resolving={null} onResolve={() => {}} onRefresh={() => {}} onConfirm={() => {}} />)
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    for (const theme of ["light", "dark"]) for (const width of [390, 430, 1024]) {
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main class="beyonix-admin-shell min-h-screen bg-beyonix-page">${markup}</main></body></html>`)
      assert.equal(await page.locator("table tbody tr").count(), 3)
      assert.equal(await page.locator("nav, aside").count(), 0)
      assert.equal(await page.getByRole("button", { name: "CONFIRMAR" }).isDisabled(), true)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}px: desborde horizontal`)
      assert.ok(await page.locator("table").evaluate((el) => el.getBoundingClientRect().width >= 300), `${theme} ${width}px: tabla estrecha`)
      const orderColor = await page.locator("table tbody tr:first-child td:first-child").evaluate((el) => getComputedStyle(el).color)
      const rootColor = await page.locator("main.max-w-2xl").evaluate((el) => getComputedStyle(el).color)
      assert.equal(orderColor, theme === "light" ? "rgb(15, 23, 42)" : "rgb(248, 250, 252)", `${theme} ${width}px: contraste del pedido; raíz ${rootColor}`)
      if (process.env.DISPATCH_CONTROL_SCREENSHOTS) await page.screenshot({ path: `${process.env.DISPATCH_CONTROL_SCREENSHOTS}/control-${theme}-${width}.png` })
    }
  } finally { await browser.close() }
})
