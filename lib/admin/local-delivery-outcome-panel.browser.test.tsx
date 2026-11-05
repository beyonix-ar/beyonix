import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { chromium, type Browser } from "playwright-core"

import { adminConfigStubs, adminPageHtml } from "./admin-config-browser-harness.ts"

// Despachos → Entregas locales con el resultado del cadete (QR): primer
// intento fallido, incidencia (reintentar / regresar), regreso a BEYONIX con
// recepción física por BX-PKG (incompleta → completa) y reserva activa/vencida.
// Componente REAL; la API se simula en memoria. ADMIN_SCREENSHOTS_DIR=<dir>.
const entry = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { LocalDeliveryPanel } from "@/app/admin/sections/despachos/local-delivery-panel"
const paid = { shipping_provider: "beyonix", financial_status: "payment_confirmed", paid_at: "2026-11-03T12:00:00Z", payment_status: "approved", payment_confirmed_amount: 45000, localidad: "ROSARIO", cp_destino: "2000", cliente_telefono: null }
const outcome = (status, extra = {}) => ({ status, failedAttempts: 0, firstAttemptFailedAt: null, secondAttemptFailedAt: null, incident: null, returningAt: null, returnedAt: null, reservation: null, returnParcels: null, ...extra })
const orders = [
  { id: 21, estado: "en_camino", ...paid, cliente_nombre: "Ana Pérez", cliente_direccion: "Córdoba 1234", outcome: outcome("first_attempt_failed", { failedAttempts: 1 }) },
  { id: 22, estado: "en_camino", ...paid, cliente_nombre: "Ñandú SRL", cliente_direccion: "Oroño 55", outcome: outcome("incident", { incident: { reason: "other", comment: "Portón con candado", at: "2026-11-05T10:00:00Z" } }) },
  { id: 23, estado: "en_camino", ...paid, cliente_nombre: "Luis", cliente_direccion: "Mitre 10", outcome: outcome("returning", { failedAttempts: 2, returnParcels: [
    { barcode: "BX-PKG-1023-01", index: 1, received: false }, { barcode: "BX-PKG-1023-02", index: 2, received: false }] }) },
  { id: 24, estado: "en_camino", ...paid, cliente_nombre: "Sofía", cliente_direccion: "Urquiza 9", outcome: outcome("returned", { failedAttempts: 2,
    reservation: { status: "active", reservationDays: 3, expiresAt: "2099-11-09T03:00:00.000Z" }, returnParcels: [{ barcode: "BX-PKG-1024-01", index: 1, received: true }] }) },
  { id: 25, estado: "en_camino", ...paid, cliente_nombre: "Juan", cliente_direccion: "Salta 3", outcome: outcome("returned", { failedAttempts: 2,
    reservation: { status: "expired", reservationDays: 3, expiresAt: "2026-11-01T03:00:00.000Z" }, returnParcels: [{ barcode: "BX-PKG-1025-01", index: 1, received: true }] }) },
  // Pedido nuevo (todavía Preparando): tiene que verse aunque haya muchos devueltos.
  { id: 26, estado: "pagado", ...paid, cliente_nombre: "Pedido nuevo", cliente_direccion: "San Juan 77", outcome: null, preparationError: null },
  // Muchos devueltos viejos (coordinación con el cliente): van en su propia sección.
  ...Array.from({ length: 60 }, (_, index) => ({ id: 300 + index, estado: "en_camino", ...paid, cliente_nombre: "Devuelto " + (index + 1), cliente_direccion: "Mitre 10",
    outcome: outcome("returned", { failedAttempts: 2, reservation: { status: "expired", reservationDays: 3, expiresAt: "2026-10-01T03:00:00.000Z" }, returnParcels: [] }) })),
]
window.__posts = []
window.confirm = () => true
window.fetch = async (input, init) => {
  const url = String(input)
  const body = init && init.method === "POST" ? JSON.parse(init.body) : null
  if (body) window.__posts.push({ url, body })
  if (url === "/api/admin/dispatch/local/returns") {
    const order = orders.find((item) => item.outcome.returnParcels && item.outcome.returnParcels.some((parcel) => parcel.barcode === body.code))
    if (!order || order.outcome.status !== "returning") return Response.json({ error: "BX-1021 no está regresando a BEYONIX: no se puede recibir como devolución local." }, { status: 409 })
    const parcel = order.outcome.returnParcels.find((item) => item.barcode === body.code)
    const duplicate = parcel.received
    parcel.received = true
    const received = order.outcome.returnParcels.filter((item) => item.received).length
    const complete = received === order.outcome.returnParcels.length
    if (complete && !duplicate) order.outcome = { ...order.outcome, status: "returned", reservation: { status: "active", reservationDays: 3, expiresAt: "2099-11-09T03:00:00.000Z" } }
    return Response.json({ ok: true, orderId: order.id, code: body.code, parcelIndex: parcel.index, parcelCount: order.outcome.returnParcels.length, received, complete, completedNow: complete && !duplicate, duplicate, reservationExpiresAt: complete ? "2099-11-09T03:00:00.000Z" : null })
  }
  if (url !== "/api/admin/dispatch/local") return Response.json({}, { status: 404 })
  if (body) {
    const order = orders.find((item) => item.id === body.orderId)
    if (body.action === "incident_retry") order.outcome = { ...order.outcome, status: order.outcome.failedAttempts ? "first_attempt_failed" : "pending", incident: null }
    if (body.action === "incident_return") order.outcome = { ...order.outcome, status: "returning", incident: null, returnParcels: [{ barcode: "BX-PKG-1022-01", index: 1, received: false }] }
    return Response.json({ ok: true })
  }
  return Response.json({ orders: orders.map((order) => ({ ...order, stage: order.estado === "pagado" ? "preparing" : "in_transit", pendingEffects: [] })) })
}
createRoot(document.getElementById("root")).render(createElement(LocalDeliveryPanel))
`

let browser: Browser
let css: string
let bundle: string
const screenshotsDir = process.env.ADMIN_SCREENSHOTS_DIR

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "local-delivery-outcome-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [adminConfigStubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  if (screenshotsDir) mkdirSync(screenshotsDir, { recursive: true })
})

test.after(async () => { await browser?.close() })

for (const theme of ["dark", "light"] as const) for (const width of [390, 1280]) {
  test(`${theme} ${width}px: resultado del cadete, incidencia, recepción de devolución local y reserva`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1100 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.route("**/*", (route) => route.request().url() === "http://admin.test/"
        ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml(theme, css, bundle) }) : route.abort())
      await page.goto("http://admin.test/")
      const panel = page.locator("[data-local-delivery-panel]")
      await panel.getByText("Entregas locales · Envío BEYONIX").waitFor({ timeout: 10_000 }).catch((error) => { throw new Error(errors.join(" | ") || String(error)) })
      const order = (id: number) => panel.locator(`[data-local-delivery-order='${id}']`)

      // Primer intento fallido: sigue entregable (segundo intento) y lo dice claramente.
      assert.match(await order(21).innerText(), /Primer intento fallido[\s\S]*1 intento fallido \(cliente ausente\) · pendiente segundo intento/i)
      assert.equal(await order(21).getByRole("button", { name: "Marcar entregado" }).count(), 1)
      // Incidencia: motivo y comentario, y las dos resoluciones.
      assert.match(await order(22).innerText(), /Incidencia de entrega[\s\S]*Incidencia: Otro — “Portón con candado”/i)
      assert.equal(await order(22).getByRole("button", { name: "Reintentar entrega" }).count(), 1)
      // Regresando / Devuelto: nunca "Marcar entregado".
      for (const id of [23, 24, 25]) assert.equal(await order(id).getByRole("button", { name: "Marcar entregado" }).count(), 0, String(id))
      assert.match(await order(24).innerText(), /Devuelto a BEYONIX[\s\S]*Reserva activa hasta 09\/11 00:00 · 3 días configurados · Esperando coordinación del cliente/i)
      assert.match(await order(25).innerText(), /Reserva vencida — stock liberado/)
      // Devueltos en su propia sección: nunca desplazan ni se mezclan con el trabajo operativo.
      const operational = panel.locator("[data-local-delivery-queue='operational']")
      const returnedQueue = panel.locator("[data-local-delivery-queue='returned']")
      assert.equal(await operational.locator("[data-local-delivery-order='26']").count(), 1, "el pedido nuevo se ve")
      assert.equal(await operational.locator("[data-local-delivery-outcome='returned']").count(), 0)
      assert.equal(await returnedQueue.locator("[data-local-delivery-outcome='returned']").count(), 62)
      assert.match(await panel.locator("[data-local-delivery-returned]").innerText(), /^Devueltos a BEYONIX · coordinación con el cliente/i)
      const firstOperational = await operational.locator("[data-local-delivery-order]").first().getAttribute("data-local-delivery-order")
      assert.equal(firstOperational, "21")
      // Nada de Andreani ni de devoluciones comerciales.
      assert.doesNotMatch(await panel.innerText(), /andreani|arrepentimiento|reclamo|garantía/i)
      if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `admin-entregas-locales-${theme}-${width}.png`), fullPage: true })

      // Recepción física: 1 de 2 → incompleta; repetir es idempotente; con el último → Devuelto + reserva.
      const returns = panel.locator("[data-local-delivery-returns]")
      assert.match(await returns.innerText(), /Recibir devolución local[\s\S]*BX-1023[\s\S]*Recepción incompleta · 0 de 2 bultos recibidos/i)
      const input = returns.getByRole("textbox", { name: "Código BX-PKG del bulto que vuelve" })
      await input.fill("BX-PKG-1023-01")
      await input.press("Enter")
      await returns.locator("[data-local-return-progress='1/2']").waitFor()
      assert.match(await returns.innerText(), /Recepción incompleta — 1 de 2 bultos/)
      assert.equal(await returns.locator("[data-local-return-parcel='BX-PKG-1023-01']").getAttribute("data-received"), "yes")
      assert.equal(await returns.locator("[data-local-return-parcel='BX-PKG-1023-02']").getAttribute("data-received"), "no")
      if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `admin-recepcion-incompleta-${theme}-${width}.png`), fullPage: true })
      await input.fill("BX-PKG-1023-02")
      await input.press("Enter")
      await panel.locator("[data-local-delivery-order='23'][data-local-delivery-outcome='returned']").waitFor()
      assert.match(await order(23).innerText(), /Devuelto a BEYONIX[\s\S]*Reserva activa hasta/i)
      assert.doesNotMatch(await order(23).innerText(), /En camino/i, "un solo estado visible")
      assert.match(await panel.innerText(), /BX-1023: Devuelto a BEYONIX\. Reserva activa hasta 09\/11 00:00\./)
      assert.equal(await panel.locator("[data-local-delivery-returns]").count(), 0, "sin pedidos regresando, la sección desaparece")

      // Incidencia → Regresar a BEYONIX: pasa a la recepción.
      await order(22).getByRole("button", { name: "Regresar a BEYONIX" }).click()
      await panel.locator("[data-local-return-order='22']").waitFor()
      assert.deepEqual((await page.evaluate("window.__posts") as Array<{ body: unknown }>).map((post) => post.body), [
        { code: "BX-PKG-1023-01" }, { code: "BX-PKG-1023-02" }, { orderId: 22, action: "incident_return" },
      ])
      assert.deepEqual(errors, [])
      if (screenshotsDir) await page.screenshot({ path: join(screenshotsDir, `admin-recepcion-completa-${theme}-${width}.png`), fullPage: true })
    } finally { await page.close() }
  })
}
