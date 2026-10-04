import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { build, type Plugin } from "esbuild"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { chromium, type Browser } from "playwright-core"

import { adminConfigStubs, adminPageHtml } from "./admin-config-browser-harness"

declare global {
  interface Window {
    __fiscalControl?: { hold: boolean; requests: Array<{ url: string; resolve: (response: Response) => void }> }
  }
}

const routerStub: Plugin = {
  name: "fiscal-router-stub",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /^navigation$/, namespace: "stub" }, () => ({ loader: "js", contents: "export function useRouter() { return { push() {} } }" }))
  },
}

const entry = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { FiscalHistoryPanel } from "@/app/admin/sections/facturacion/fiscal-history-panel"
const today = new Intl.DateTimeFormat("en-US", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date())
const values = Object.fromEntries(today.map((part) => [part.type, part.value]))
const day = values.year + "-" + values.month + "-" + values.day
window.__fiscalControl = { hold: false, requests: [] }
window.fetch = async (input) => {
  const url = new URL(String(input), location.href)
  if (url.pathname === "/api/admin/facturacion/history" && window.__fiscalControl.hold) {
    return new Promise((resolve) => window.__fiscalControl.requests.push({ url: url.toString(), resolve }))
  }
  if (url.pathname === "/api/admin/facturacion/history") return Response.json({ items: [
    { kind: "invoice", id: "19", order_id: 19, point: 1, number: 3, display_number: "0001-00000003", client: "Lucas Espinosa", document: "30111222", issued_at: day + "T15:00:00Z", day, amount: 100, cae: "CAE-123", status: "authorized", environment: "production", reason: null, original_point: null, original_number: null }
  ], total: 1, page: 1, pageSize: 30 })
  return Response.json({ error: "Unexpected" }, { status: 500 })
}

createRoot(document.getElementById("root")).render(createElement(FiscalHistoryPanel, { kind: "invoice" }))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  bundle = (await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "fiscal-history-browser-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [adminConfigStubs, routerStub],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })).outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => { await browser?.close() })

test("respuestas viejas de filtro, mes, año y página no pisan la última consulta", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.route("**/*", (route) => route.request().url() === "http://admin.test/"
    ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml("light", css, bundle) })
    : route.abort())
  const control = () => page.evaluate(() => window.__fiscalControl?.requests.length ?? 0)
  const settle = (index: number, id: string, total: number, error = false) => page.evaluate(({ index, id, total, error }) => {
    const fiscal = window.__fiscalControl!
    fiscal.requests[index].resolve(error
      ? Response.json({ error: "Error anterior" }, { status: 503 })
      : Response.json({ items: [{ kind: "invoice", id, order_id: Number(id), point: 1, number: Number(id), display_number: `0001-${id.padStart(8, "0")}`, client: "Cliente", document: null, issued_at: "2026-10-03T15:00:00Z", day: "2026-10-03", amount: 100, cae: "CAE", status: "authorized", environment: "production", reason: null, original_point: null, original_number: null }], total, page: 1, pageSize: 30 }))
  }, { index, id, total, error })
  try {
    await page.goto("http://admin.test/")
    await page.locator("[data-fiscal-row]").waitFor()
    await page.evaluate(() => { window.__fiscalControl!.hold = true })
    await page.getByRole("button", { name: "Historial" }).click()
    await page.waitForFunction(() => (window.__fiscalControl?.requests.length ?? 0) >= 1)
    await page.getByRole("button", { name: "Mes fiscal" }).click()
    await page.getByRole("option", { name: "Septiembre" }).click()
    await page.waitForFunction(() => (window.__fiscalControl?.requests.length ?? 0) >= 2)
    await page.getByRole("button", { name: "Año anterior" }).click()
    await page.waitForFunction(() => (window.__fiscalControl?.requests.length ?? 0) >= 3)
    await page.getByRole("textbox", { name: "Buscar comprobantes" }).fill("Filtro nuevo")
    await page.waitForFunction(() => (window.__fiscalControl?.requests.length ?? 0) >= 4)
    assert.equal(await control(), 4)
    await settle(3, "40", 31)
    await page.locator('[data-fiscal-row="40"]').waitFor()
    await settle(0, "10", 1, true)
    await settle(1, "20", 1)
    await settle(2, "30", 1)
    assert.equal(await page.locator('[data-fiscal-row="40"]').count(), 1)
    assert.match(await page.locator("[data-fiscal-history]").innerText(), /31 resultados/)
    assert.equal(await page.getByText("Error anterior").count(), 0)

    await page.getByRole("button", { name: "Siguiente", exact: true }).click()
    await page.waitForFunction(() => (window.__fiscalControl?.requests.length ?? 0) >= 5)
    await page.getByRole("textbox", { name: "Buscar comprobantes" }).fill("Otro filtro")
    await page.waitForFunction(() => (window.__fiscalControl?.requests.length ?? 0) >= 6)
    await settle(5, "60", 1)
    await page.locator('[data-fiscal-row="60"]').waitFor()
    await settle(4, "50", 31)
    assert.equal(await page.locator('[data-fiscal-row="60"]').count(), 1)
    assert.match(await page.locator("[data-fiscal-history]").innerText(), /1 resultados · página 1/)
  } finally {
    await page.close()
  }
})

test("Este mes calcula el mes argentino al pulsar incluso tras cruzar medianoche", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.clock.install({ time: new Date("2026-10-31T12:00:00-03:00") })
  await page.route("**/*", (route) => route.request().url() === "http://admin.test/"
    ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml("light", css, bundle) })
    : route.abort())
  try {
    await page.goto("http://admin.test/")
    await page.locator("[data-fiscal-row]").waitFor()
    await page.clock.setFixedTime(new Date("2026-11-01T12:00:00-03:00"))
    await page.evaluate(() => { window.__fiscalControl!.hold = true })
    await page.getByRole("button", { name: "Este mes" }).click()
    await page.waitForFunction(() => (window.__fiscalControl?.requests.length ?? 0) >= 1)
    const query = await page.evaluate(() => new URL(window.__fiscalControl!.requests[0].url).searchParams.toString())
    const params = new URLSearchParams(query)
    assert.equal(params.get("period"), "month")
    assert.equal(params.get("year"), "2026")
    assert.equal(params.get("month"), "11")
  } finally {
    await page.close()
  }
})


for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 768, 1280]) {
    test(`${theme} ${width}px: historial fiscal legible y sin overflow`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      await page.route("**/*", (route) => route.request().url() === "http://admin.test/"
        ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml(theme, css, bundle) })
        : route.abort())
      try {
        await page.goto("http://admin.test/")
        await page.locator("[data-fiscal-row]").waitFor({ timeout: 10_000 })
        const dimensions = await page.evaluate(() => ({
          document: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
          offenders: [...document.querySelectorAll("[data-fiscal-history] *")]
            .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
            .slice(0, 5).map((element) => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right })),
        }))
        assert.ok(dimensions.document <= dimensions.viewport + 1, JSON.stringify(dimensions))
        assert.equal(await page.locator("[data-fiscal-row]").count(), 1)
        assert.equal(await page.getByText("Descargar mes completo").isVisible(), true)
        assert.equal(await page.getByText("Ver comprobante").isVisible(), true)
        const colors = await page.locator("[data-fiscal-history]").evaluate((element) => ({
          panel: getComputedStyle(element).backgroundColor,
          page: getComputedStyle(document.querySelector(".beyonix-admin-main")!).backgroundColor,
          theme: document.documentElement.getAttribute("data-admin-theme"),
          matches: element.matches('html[data-admin-theme="dark"] .beyonix-admin-main [data-fiscal-history]'),
        }))
        assert.notEqual(colors.panel, colors.page, JSON.stringify(colors))
      } finally {
        await page.close()
      }
    })
  }

  test(`${theme}: Facturación reutiliza Select y calendario Admin, sin controles nativos`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } })
    await page.route("**/*", (route) => route.request().url() === "http://admin.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml(theme, css, bundle) })
      : route.abort())
    try {
      await page.goto("http://admin.test/")
      await page.locator("[data-fiscal-row]").waitFor({ timeout: 10_000 })
      assert.equal(await page.locator("[data-fiscal-history] select, [data-fiscal-history] input[type=date]").count(), 0)
      await page.getByRole("button", { name: "Mes fiscal" }).click()
      assert.equal(await page.getByRole("listbox", { name: "Mes fiscal" }).isVisible(), true)
      await page.getByRole("option", { name: "Octubre" }).click()
      await page.getByText("Filtros", { exact: true }).click()
      for (const label of ["Buscar comprobantes", "Número de comprobante", "Pedido", "Cliente", "Documento", "Fecha desde", "Fecha hasta", "CAE", "Importe"]) {
        const input = page.getByLabel(label, { exact: true })
        assert.equal(await input.getAttribute("autocomplete"), "off", label)
        assert.match(await input.getAttribute("name") ?? "", /^bx_fiscal_invoice_(?:search|number|order|client|document|from|to|cae|amount)$/, label)
      }
      await page.getByRole("button", { name: "Estado" }).click()
      assert.equal(await page.getByRole("listbox", { name: "Estado" }).isVisible(), true)
      await page.getByRole("option", { name: "Autorizada" }).click()
      assert.equal(await page.getByRole("textbox", { name: "Fecha desde" }).getAttribute("type"), "text")
      await page.getByRole("button", { name: "Abrir calendario" }).first().click()
      assert.equal(await page.getByText("Seleccionar fecha").isVisible(), true)
      const dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }))
      assert.ok(dimensions.document <= dimensions.viewport + 1, JSON.stringify(dimensions))
    } finally {
      await page.close()
    }
  })
}
