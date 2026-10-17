import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { chromium } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

test("listas compactas de Despachos: 390, 1024 y 1440 px en light/dark", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-queue.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-queue-key"
  const { OrderQueueCard } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const base = { id: 6, created_at: "2026-10-16T15:32:00-03:00", cliente_nombre: "María José Peña", estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized", shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, andreani_envio_id: "ENV-6", andreani_tracking: "360000001006", andreani_creation_status: "created", package: { id: 6, order_id: 6, status: "prepared" as const, attempt_number: 1, prepared_at: "2026-10-16T15:30:00Z", prepared_by: null, identification_method: "andreani" as const }, membership: null, itemCount: 3, units: 5 }
  const markup = renderToStaticMarkup(<div className="beyonix-admin-main"><div className="dispatch-surface"><OrderQueueCard item={base} tab="ready" checked={false} onToggle={() => {}} onOpen={() => {}} /></div></div>)
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    for (const theme of ["light", "dark"]) for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>${markup}</body></html>`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}: sin desborde`)
      assert.match(await page.locator(".dispatch-queue-card").innerText(), /BX-1006[\s\S]*María José Peña[\s\S]*3 productos[\s\S]*5 unidades/)
      const color = await page.locator(".dispatch-queue-card .font-black.tabular-nums").evaluate((element) => getComputedStyle(element).color)
      assert.equal(color, theme === "light" ? "rgb(23, 36, 51)" : "rgb(255, 255, 255)")
    }
  } finally { await browser.close() }
})
