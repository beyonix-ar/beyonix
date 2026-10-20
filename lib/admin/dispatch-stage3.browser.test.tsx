import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { chromium } from "playwright-core"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

import { DispatchLabel } from "../../app/admin/sections/despachos/dispatch-label"
import { ScanField } from "../../app/admin/sections/despachos/scan-field"
import type { DispatchBatch } from "./dispatch"

const batch: DispatchBatch = { id: 1, code: "DSP-20261005-001", status: "closed", created_at: "2026-10-05T12:00:00Z", closed_at: "2026-10-05T13:00:00Z", handed_over_at: null, handed_over_by: null }

test("etiqueta de Bulto general: contenido, contraste y ancho en light/dark", async () => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
    const markup = renderToStaticMarkup(<DispatchLabel batch={batch} barcodeUrl="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E" />)
    for (const theme of ["light", "dark"]) for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body><main class="beyonix-admin-main"><div class="dispatch-bundle-closed">${markup}</div></main></body></html>`)
      const label = page.locator("#dispatch-print-label")
      assert.match(await label.textContent() ?? "", /Bulto general\s*DSP-20261005-001/)
      assert.doesNotMatch(await label.textContent() ?? "", /BEYONIX|Pedidos:|Paquetes:|05\/10\/2026/)
      assert.match(await label.locator("img").getAttribute("alt") ?? "", /Code 128/)
      assert.equal(await label.evaluate((el) => getComputedStyle(el).backgroundColor), theme === "light" ? "rgb(255, 255, 255)" : "rgb(32, 42, 54)")
      assert.equal(await label.locator(".dispatch-label-barcode").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)")
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}`)
    }
  } finally { await browser.close() }
})

test("DSP y acciones de impresión: contraste y ancho en light/dark", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-browser.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-browser-key"
  const { LabelPrintDialog } = await import("../../app/admin/components/label-print-dialog")
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const markup = renderToStaticMarkup(<><div className="beyonix-admin-main"><ScanField label="Escanear o ingresar DSP" placeholder="Escaneá DSP-20261016-001" submitLabel="Verificar DSP" value="" onChange={() => {}} onScan={() => {}} cameraTitle="Escanear Bulto general" cameraHint="DSP" /></div><LabelPrintDialog open title="Etiqueta del Bulto general" labels={[{ kind: "batch", code: "DSP-20261016-001" }]} onClose={() => {}} /></>)
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    for (const theme of ["light", "dark"]) for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body>${markup}</body></html>`)
      const input = page.getByRole("textbox", { name: "Escanear o ingresar DSP" })
      assert.equal(await input.isDisabled(), false)
      const color = await input.evaluate((el) => getComputedStyle(el).color)
      assert.equal(color, theme === "light" ? "rgb(23, 36, 51)" : "rgb(248, 250, 252)")
      assert.equal(await page.getByRole("button", { name: "Imprimir", exact: true }).count(), 1)
      assert.equal(await page.getByRole("button", { name: "Guardar PDF" }).count(), 1)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}`)
    }
  } finally { await browser.close() }
})

test("módulo Despachos: cuatro etapas, superficies opacas y sin desborde en Light/Dark", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-browser.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-browser-key"
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const markup = renderToStaticMarkup(<AdminDispatches />)
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    for (const theme of ["light", "dark"]) for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      await page.setContent(`<html data-admin-theme="${theme}"><head><style>${css}</style></head><body><div class="beyonix-admin-shell"><main class="beyonix-admin-main">${markup}</main></div></body></html>`)
      // Pendientes -> Confirmados -> Bultos -> Entregados (historial de Bultos entregados, 4730ee7).
      assert.deepEqual(await page.locator('nav[aria-label="Estados de despacho"] button').allTextContents(),
        ["Pendientes", "Confirmados", "Bultos", "Entregados"])
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}`)
      const opaque = await page.locator(".admin-ds-surface").first().evaluate((el) => getComputedStyle(el).backgroundColor)
      assert.notEqual(opaque, "rgba(0, 0, 0, 0)", `${theme} ${width}`)
    }
  } finally { await browser.close() }
})
