import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { chromium, type Browser } from "playwright-core"

import { adminConfigStubs, adminPageHtml } from "./admin-config-browser-harness.ts"

// Despachos → Entregas locales (Envío BEYONIX) con el componente REAL:
// Preparando → En camino → Entregado, sin etiqueta, guía ni Bulto. La API se
// simula en memoria con las mismas transiciones que el servidor.
const entry = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { LocalDeliveryPanel } from "@/app/admin/sections/despachos/local-delivery-panel"
import { getLocalDeliveryStage, getLocalDeliveryTransitionError } from "@/lib/orders/local-delivery-status"
const orders = [
  { id: 11, estado: "pagado", shipping_provider: "beyonix", financial_status: "payment_confirmed", paid_at: "2026-11-03T12:00:00Z", cliente_nombre: "Ana Pérez", cliente_direccion: "Córdoba 1234", localidad: "ROSARIO", cp_destino: "2000", cliente_telefono: "3415550000" },
  { id: 12, estado: "en_camino", shipping_provider: "beyonix", financial_status: "payment_confirmed", paid_at: "2026-11-03T12:00:00Z", cliente_nombre: "Ñandú SRL", cliente_direccion: "Oroño 55", localidad: "ROSARIO", cp_destino: "2000", cliente_telefono: null },
  { id: 13, estado: "entregado", delivered_at: "2026-11-03T14:00:00Z", shipping_provider: "beyonix", financial_status: "payment_confirmed", paid_at: "2026-11-03T12:00:00Z", cliente_nombre: "Luis", cliente_direccion: "Mitre 10", localidad: "ROSARIO", cp_destino: "2000", cliente_telefono: null },
]
// Efectos que fallaron y quedan para "Reintentar avisos".
const pending = { 13: ["delivered_email"] }
window.__posts = []
window.confirm = () => true
window.fetch = async (input, init) => {
  if (String(input) !== "/api/admin/dispatch/local") return Response.json({}, { status: 404 })
  if (init && init.method === "POST") {
    const body = JSON.parse(init.body)
    window.__posts.push(body)
    if (body.action === "retry_effects") { pending[body.orderId] = []; return Response.json({ ok: true, pendingEffects: [] }) }
    const order = orders.find((item) => item.id === body.orderId)
    const error = getLocalDeliveryTransitionError(order, body.action)
    if (error) return Response.json({ error }, { status: 409 })
    order.estado = body.action
    if (body.action === "entregado") order.delivered_at = "2026-11-03T15:00:00Z"
    return Response.json({ ok: true })
  }
  return Response.json({ orders: orders.map((order) => ({ ...order, stage: getLocalDeliveryStage(order), pendingEffects: pending[order.id] ?? [] })) })
}
createRoot(document.getElementById("root")).render(createElement(LocalDeliveryPanel))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "local-delivery-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [adminConfigStubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

for (const theme of ["dark", "light"] as const) for (const width of [390, 1280]) {
  test(`${theme} ${width}px: entregas locales Preparando → En camino → Entregado, sin Andreani`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.route("**/*", (route) =>
        route.request().url() === "http://admin.test/"
          ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml(theme, css, bundle) })
          : route.abort(),
      )
      await page.goto("http://admin.test/")
      const panel = page.locator("[data-local-delivery-panel]")
      await panel.getByText("Entregas locales · Envío BEYONIX").waitFor({ timeout: 10_000 }).catch((error) => {
        throw new Error(errors.join(" | ") || String(error))
      })
      const order = (id: number) => panel.locator(`[data-local-delivery-order='${id}']`)
      assert.equal(await order(11).getAttribute("data-local-delivery-stage"), "preparing")
      assert.match(await order(11).innerText(), /BX-1011[\s\S]*Preparando[\s\S]*Ana Pérez · Córdoba 1234 · ROSARIO · CP 2000/i)
      assert.equal(await order(12).getAttribute("data-local-delivery-stage"), "in_transit")
      // Sin acciones ni textos de Andreani (etiqueta, guía, Bulto, seguimiento).
      assert.doesNotMatch(await panel.innerText(), /andreani|etiqueta|bulto|seguimiento/i)
      // Sólo el próximo paso: Preparando no ofrece "Marcar entregado"; En camino no ofrece "Marcar en camino".
      assert.equal(await order(11).getByRole("button", { name: "Marcar entregado" }).count(), 0)
      assert.equal(await order(12).getByRole("button", { name: "Marcar en camino" }).count(), 0)
      assert.equal(await order(12).getByRole("button", { name: "Marcar entregado" }).count(), 1)
      // Entregado con un aviso fallido: sin avances, sólo "Reintentar avisos".
      assert.match(await order(13).innerText(), /Pendiente: email al cliente/)
      assert.deepEqual(await order(13).getByRole("button").allInnerTexts().then((texts) => texts.map((text) => text.trim())), ["Reintentar avisos"])
      await order(13).getByRole("button", { name: "Reintentar avisos" }).click()
      await page.waitForFunction(() => !document.querySelector("[data-local-delivery-order='13'] [data-local-delivery-pending]"))
      assert.equal(await order(13).getByRole("button").count(), 0)

      await order(11).getByRole("button", { name: "Marcar en camino" }).click()
      await page.waitForFunction(() => document.querySelector("[data-local-delivery-order='11']")?.getAttribute("data-local-delivery-stage") === "in_transit")
      await order(11).getByRole("button", { name: "Marcar entregado" }).click()
      await page.waitForFunction(() => document.querySelector("[data-local-delivery-order='11']")?.getAttribute("data-local-delivery-stage") === "delivered")
      assert.equal(await order(11).getByRole("button").count(), 0, "entregado: sin acciones")
      assert.deepEqual(await page.evaluate("window.__posts"), [
        { orderId: 13, action: "retry_effects" },
        { orderId: 11, action: "en_camino" },
        { orderId: 11, action: "entregado" },
      ])
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no se ensancha la página")
      assert.deepEqual(errors, [])
    } finally {
      await page.close()
    }
  })
}
