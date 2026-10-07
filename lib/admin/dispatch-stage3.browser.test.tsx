import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { chromium } from "playwright-core"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

import { DispatchLabel } from "../../app/admin/sections/despachos/dispatch-label"
import type { DispatchBatch } from "./dispatch"

const batch: DispatchBatch = { id: 1, code: "DSP-20261005-001", status: "closed", created_at: "2026-10-05T12:00:00Z", closed_at: "2026-10-05T13:00:00Z", handed_over_at: null, handed_over_by: null }

test("etiqueta de lote: contenido, impresión, celular y fondos sólidos", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    const markup = renderToStaticMarkup(<DispatchLabel batch={batch} orderCount={3} parcelCount={7} barcodeUrl="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E" />)
    await page.setViewportSize({ width: 390, height: 800 })
    await page.setContent(`<html><head><style>body{margin:0;background:#101820}#dispatch-print-label{background:#fff;color:#000;box-sizing:border-box;max-width:360px;padding:20px;margin:20px auto}img{width:100%}@media print {body>*:not(#dispatch-print-label){display:none}}</style></head><body><div>Panel Admin</div>${markup}</body></html>`)
    assert.equal(await page.locator("#dispatch-print-label strong").first().textContent(), "BEYONIX")
    assert.match(await page.locator("#dispatch-print-label").textContent() ?? "", /DSP-20261005-001/)
    assert.match(await page.locator("#dispatch-print-label").textContent() ?? "", /Pedidos: 3 \/ Bultos: 7/)
    assert.match(await page.locator("#dispatch-print-label img").getAttribute("alt") ?? "", /Code 128/)
    assert.equal(await page.locator("#dispatch-print-label").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)")
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.emulateMedia({ media: "print" })
    assert.equal(await page.locator("body > div").first().evaluate((el) => getComputedStyle(el).display), "none")
  } finally { await browser.close() }
})

test("módulo Despachos: cinco vistas, superficies opacas y sin desborde en Light/Dark", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-browser.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-browser-key"
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const markup = renderToStaticMarkup(<AdminDispatches />)
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body><div class="beyonix-admin-shell"><main class="beyonix-admin-main">${markup}</main></div></body></html>`)
      assert.equal(await page.locator('nav[aria-label="Estados de despacho"] button').count(), 5)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}`)
      const opaque = await page.locator(".admin-ds-surface").first().evaluate((el) => getComputedStyle(el).backgroundColor)
      assert.notEqual(opaque, "rgba(0, 0, 0, 0)", `${theme} ${width}`)
    }
  } finally { await browser.close() }
})
