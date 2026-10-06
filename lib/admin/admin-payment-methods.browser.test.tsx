import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { chromium, type Browser, type Page } from "playwright-core"

import {
  adminConfigStubs,
  adminPageHtml,
  CONTRAST_AUDIT,
  costsOverview,
  OBSERVED,
  SETTINGS,
} from "./admin-config-browser-harness.ts"

// Admin → Financiación → "MEDIOS DE PAGO DISPONIBLES" con los componentes
// REALES (bundle esbuild) y la lógica real de visibilidad. Las APIs se
// simulan en el navegador con estado en memoria.

const STORAGE = "https://storage.test/payment-method-logos"
const NOW = "2026-10-06T12:00:00.000Z"
const base = {
  provider_name: null,
  provider_payment_types: ["credit_card"],
  provider_status: "active",
  image_path: null,
  enabled: true,
  needs_review: false,
  first_seen_at: NOW,
  last_seen_at: NOW,
  last_synced_at: NOW,
  updated_at: NOW,
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const ROWS = [
  { ...base, id: id(1), source: "mercadopago", provider_method_id: "visa", display_name: "Visa", provider_payment_types: ["credit_card", "prepaid_card"], image_path: `${id(1)}/1759752000000.svg` },
  { ...base, id: id(2), source: "mercadopago", provider_method_id: "master", display_name: "Mastercard" },
  { ...base, id: id(3), source: "mercadopago", provider_method_id: "naranja", display_name: "Naranja", provider_status: "missing", image_path: `${id(3)}/1759752000000.png` },
  { ...base, id: id(4), source: "mercadopago", provider_method_id: "rapipago", display_name: "Rapipago", provider_payment_types: ["ticket"] },
  { ...base, id: id(5), source: "mercadopago", provider_method_id: "argencard", display_name: "Argencard", needs_review: true },
  { ...base, id: id(6), source: "manual", provider_method_id: null, provider_status: null, provider_payment_types: [], display_name: "MODO", enabled: false },
]

const ENTRY = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { AdminFinanciacion } from "@/app/admin/sections/financiacion/admin-financiacion"
import { toAdminPaymentMethodLogo } from "@/lib/payments/payment-method-logos"

const STORAGE = ${JSON.stringify(STORAGE)}
let rows = ${JSON.stringify(ROWS)}
let sync = { lastAttemptAt: "${NOW}", lastSuccessAt: "${NOW}", lastError: null }
window.__uploads = []
window.__syncMode = "ok"
const overview = () => ({ sync, methods: rows.map((row) => toAdminPaymentMethodLogo(row, row.image_path ? STORAGE + "/" + row.image_path : null)) })
const ok = () => Response.json({ paymentMethods: overview() })
const API = "/api/admin/financiacion/medios-de-pago"

window.fetch = async (input, init = {}) => {
  const path = String(input)
  const method = init.method || "GET"
  if (path === "/api/admin/settings") {
    return Response.json({ settings: ${JSON.stringify(SETTINGS)}, mercadoPagoCosts: ${JSON.stringify(costsOverview("automatic", OBSERVED))} })
  }
  if (path === API && method === "GET") return ok()
  if (path === API && method === "POST") {
    const { displayName } = JSON.parse(init.body)
    rows = [...rows, { ...rows[5], id: "00000000-0000-4000-8000-000000000099", display_name: displayName, enabled: false, image_path: null }]
    return ok()
  }
  if (path === API + "/sync") {
    if (window.__syncMode === "fail") {
      sync = { ...sync, lastAttemptAt: "2026-10-07T12:00:00.000Z", lastError: "Mercado Pago no respondió a tiempo." }
      return Response.json({ error: sync.lastError, paymentMethods: overview() }, { status: 502 })
    }
    rows = [...rows, { ...rows[1], id: "00000000-0000-4000-8000-000000000077", provider_method_id: "cabal", display_name: "Cabal", needs_review: true }]
    sync = { lastAttemptAt: "2026-10-07T12:00:00.000Z", lastSuccessAt: "2026-10-07T12:00:00.000Z", lastError: null }
    return ok()
  }
  const match = path.match(/^\\/api\\/admin\\/financiacion\\/medios-de-pago\\/([0-9a-f-]+)(\\/imagen)?$/)
  if (match) {
    const [, rowId, image] = match
    const row = rows.find((item) => item.id === rowId)
    if (image && method === "POST") {
      const file = init.body.get("file")
      window.__uploads.push({ name: file.name, type: file.type, size: file.size })
      const extension = file.type === "image/svg+xml" ? "svg" : "png"
      Object.assign(row, { image_path: rowId + "/" + (1759752000000 + window.__uploads.length) + "." + extension, needs_review: false })
      return ok()
    }
    if (image && method === "DELETE") { row.image_path = null; return ok() }
    if (method === "PATCH") {
      const body = JSON.parse(init.body)
      if (body.enabled !== undefined) row.enabled = body.enabled
      if (body.reviewed) row.needs_review = false
      return ok()
    }
    if (method === "DELETE") { rows = rows.filter((item) => item.id !== rowId); return ok() }
  }
  return Response.json({})
}
createRoot(document.getElementById("root")).render(createElement(AdminFinanciacion))
`

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 60"><rect width="300" height="60" fill="#1a1f71"/></svg>'
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64")

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-payment-methods-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [adminConfigStubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light", width = 1280): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", (route) => {
    const url = route.request().url()
    if (url === "http://admin.test/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml(theme, css, bundle) })
    if (url.startsWith(STORAGE)) return url.endsWith(".svg") ? route.fulfill({ contentType: "image/svg+xml", body: SVG }) : route.fulfill({ contentType: "image/png", body: PNG_1PX })
    return route.abort()
  })
  await page.goto("http://admin.test/")
  try {
    await page.locator("[data-payment-methods-open] [data-new-methods-count]").waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

const row = (page: Page, methodId: string) => page.locator(`[data-payment-method='${methodId}']`)

async function openModal(page: Page) {
  await page.locator("[data-payment-methods-open]").click()
  await page.locator("[data-payment-methods-manager]").waitFor()
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: botón discreto con aviso de nuevos; modal con estado de Mercado Pago y reglas de visibilidad`, async () => {
    const page = await open(theme)
    try {
      const button = page.locator("[data-payment-methods-open]")
      assert.match(await button.innerText(), /MEDIOS DE PAGO DISPONIBLES/)
      await button.getByText("1 nuevo").waitFor()
      // Discreto: misma altura que la acción compacta "Comprobar ahora" y una sola línea.
      const [box, reference] = await Promise.all([button.boundingBox(), page.locator("[data-check-reference]").boundingBox()])
      assert.ok(box && reference && box.height <= reference.height + 1, `botón compacto (${box?.height}px vs ${reference?.height}px)`)
      assert.ok(box && box.width <= 360, `no ocupa mucho lugar (${box?.width}px)`)

      await openModal(page)
      await page.getByRole("dialog").getByText("Pagos disponibles en Mercado Pago").waitFor()
      await page.locator("[data-sync-status='synced']").waitFor()
      await page.locator("[data-new-methods-alert]").getByText(/Hay 1 nuevo medio disponible/).waitFor()

      assert.equal(await row(page, "visa").getAttribute("data-visible"), "true")
      await row(page, "visa").getByText("Visible para clientes").waitFor()
      await row(page, "visa").locator("[data-logo-preview] img").waitFor()
      await row(page, "master").getByText("Oculto: falta la imagen").waitFor()
      await row(page, "naranja").getByText("Ya no figura en Mercado Pago", { exact: true }).waitFor()
      await row(page, "naranja").getByText("Oculto: ya no figura en Mercado Pago").waitFor()
      assert.equal(await row(page, "naranja").locator("[data-logo-preview]").count(), 1, "la imagen se conserva")
      await row(page, "rapipago").getByText("Oculto: el checkout no ofrece este tipo de pago").waitFor()
      await row(page, "argencard").getByText("Nuevo medio disponible").waitFor()
      await row(page, "argencard").locator("[data-upload-hint]").waitFor()
      assert.equal(await page.locator("[data-payment-method-list='manual'] [data-source='manual']").count(), 1)
      await page.locator("[data-source='manual']").getByText("Oculto: falta la imagen").waitFor()

      const { failures, audited } = (await page.evaluate(CONTRAST_AUDIT)) as { audited: number; failures: string[] }
      assert.ok(audited > 30, `se auditaron ${audited} textos`)
      assert.deepEqual(failures, [], "contraste AA en el modal")
      if (process.env.ADMIN_PAYMENT_SHOTS) await page.screenshot({ path: `${process.env.ADMIN_PAYMENT_SHOTS}/admin-payment-methods-${theme}.png` })
    } finally {
      await page.close()
    }
  })

  test(`${theme}: subir SVG, reemplazar por PNG y quitar imagen`, async () => {
    const page = await open(theme)
    try {
      await openModal(page)
      await row(page, "argencard").locator("[data-logo-input]").setInputFiles({ name: "argencard.svg", mimeType: "image/svg+xml", buffer: Buffer.from(SVG) })
      await page.locator("[data-payment-methods-feedback]").getByText("Imagen guardada.").waitFor()
      await row(page, "argencard").getByText("Visible para clientes").waitFor()
      assert.equal(await row(page, "argencard").getByText("Nuevo medio disponible").count(), 0, "cargar la imagen resuelve el aviso")
      assert.equal(await page.locator("[data-new-methods-alert]").count(), 0)
      await row(page, "argencard").getByRole("button", { name: /Reemplazar/ }).waitFor()

      await row(page, "argencard").locator("[data-logo-input]").setInputFiles({ name: "argencard.png", mimeType: "image/png", buffer: PNG_1PX })
      await row(page, "argencard").locator("[data-logo-preview] img[src$='.png']").waitFor()
      assert.deepEqual(
        ((await page.evaluate("window.__uploads")) as Array<{ name: string; type: string }>).map((upload) => [upload.name, upload.type]),
        [["argencard.svg", "image/svg+xml"], ["argencard.png", "image/png"]],
      )
      const preview = await row(page, "argencard").locator("[data-logo-preview] img").evaluate((image) => getComputedStyle(image).objectFit)
      assert.equal(preview, "contain")

      await row(page, "argencard").locator("[data-logo-remove]").click()
      await row(page, "argencard").getByText("Oculto: falta la imagen").waitFor()
      await row(page, "argencard").locator("[data-logo-empty]").waitFor()
    } finally {
      await page.close()
    }
  })

  test(`${theme}: actualizar desde Mercado Pago muestra medios nuevos; si falla conserva el último estado`, async () => {
    const page = await open(theme)
    try {
      await openModal(page)
      await page.locator("[data-sync-payment-methods]").click()
      await row(page, "cabal").getByText("Nuevo medio disponible").waitFor()
      await page.locator("[data-new-methods-alert]").getByText(/Hay 2 nuevos medios disponibles/).waitFor()
      await page.locator("[data-last-sync]").getByText(/7\/10/).waitFor()

      // "Marcar revisado" quita el aviso sin cargar imagen (el medio sigue oculto).
      await row(page, "cabal").locator("[data-mark-reviewed]").click()
      await page.locator("[data-payment-methods-feedback]").getByText("Medio marcado como revisado.").waitFor()
      assert.equal(await row(page, "cabal").getByText("Nuevo medio disponible").count(), 0)
      await row(page, "cabal").getByText("Oculto: falta la imagen").waitFor()
      await page.locator("[data-new-methods-alert]").getByText(/Hay 1 nuevo medio disponible/).waitFor()
      await page.locator("[data-payment-methods-open] [data-new-methods-count]").getByText("1 nuevo").waitFor()

      await page.evaluate(() => { (window as unknown as { __syncMode: string }).__syncMode = "fail" })
      await page.locator("[data-sync-payment-methods]").click()
      await page.locator("[data-sync-error]").getByText(/Mercado Pago no respondió a tiempo\. Se conserva el último estado conocido/).waitFor()
      await page.locator("[data-sync-status='failed']").waitFor()
      assert.equal(await row(page, "visa").getAttribute("data-visible"), "true", "lo visible sigue visible")
      assert.equal(await row(page, "cabal").count(), 1)
      const { failures } = (await page.evaluate(CONTRAST_AUDIT)) as { failures: string[] }
      assert.deepEqual(failures, [], "contraste con error")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: medio manual/externo nace inactivo, se activa a mano y se puede eliminar`, async () => {
    const page = await open(theme)
    try {
      await openModal(page)
      await page.getByLabel("Nombre del medio manual").fill("Cuenta DNI – Ñandú")
      await page.locator("[data-manual-create]").click()
      const created = page.locator("[data-source='manual']").filter({ hasText: "Cuenta DNI – Ñandú" })
      await created.waitFor()
      await created.getByText("Medio manual / externo · no se informa como medio de Mercado Pago").waitFor()
      const toggle = created.locator("[data-enabled-toggle]")
      assert.equal(await toggle.getAttribute("aria-pressed"), "false")
      await toggle.click()
      await created.locator("[data-enabled-toggle][aria-pressed='true']").waitFor()
      await created.getByText("Oculto: falta la imagen").waitFor()

      await created.locator("[data-delete]").click()
      await created.locator("[data-delete-confirm-button]").click()
      await page.locator("[data-payment-methods-feedback]").getByText("Medio manual eliminado.").waitFor()
      assert.equal(await page.locator("[data-source='manual']").filter({ hasText: "Cuenta DNI" }).count(), 0)
      assert.equal(await row(page, "visa").locator("[data-delete]").count(), 0, "los medios de Mercado Pago no se eliminan")
    } finally {
      await page.close()
    }
  })

  test(`${theme}: mobile (390px) sin scroll horizontal y con acciones dentro de la pantalla`, async () => {
    const page = await open(theme, 390)
    try {
      await openModal(page)
      const overflow = await page.evaluate(() => {
        const dialog = document.querySelector("[role='dialog']") as HTMLElement
        return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, dialog: dialog.scrollWidth - dialog.clientWidth }
      })
      assert.ok(overflow.page <= 0 && overflow.dialog <= 0, `sin desborde: ${JSON.stringify(overflow)}`)
      for (const selector of ["[data-sync-payment-methods]", "[data-payment-method='master'] [data-logo-upload]", "[data-payment-method='master'] [data-enabled-toggle]", "[data-manual-create]"]) {
        const box = await page.locator(selector).boundingBox()
        assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${selector} dentro de la pantalla`)
      }
    } finally {
      await page.close()
    }
  })
}
