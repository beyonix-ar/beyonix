import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { build } from "esbuild"
import { PDFDocument } from "pdf-lib"
import { chromium, type Browser, type Page } from "playwright-core"

import { adminConfigStubs, adminPageHtml } from "../admin/admin-config-browser-harness.ts"
import { buildLabelTargets, type LabelCatalogProduct } from "./catalog.ts"
import { encodeBarcodePattern } from "./encode.ts"
import { LABEL_QUEUE_STORAGE_KEY, createQueueItem, type LabelQueueItem } from "./queue.ts"

// Admin → Etiquetas con el componente real y APIs simuladas. Verifica la
// selección compacta, el flujo de vistas y las salidas A4 y térmica.

const EAN_A = "7790001000019"
const EAN_B = "7790895000997"
const EAN_C = "7891000315507"

const CATALOG: LabelCatalogProduct[] = [
  {
    id: 10, name: "Encendedor USB", active: true, sku: null, barcode: null, price: 12999, randomSale: false,
    variants: [
      { id: 101, name: "MARRÓN", active: true, stock: 5, sku: "ENC-MAR", colorHex: "#8B5A2B", colorHexSecondary: null, barcode: EAN_A },
      { id: 102, name: "NEGRO", active: true, stock: 3, sku: "ENC-NEG", colorHex: "#000000", colorHexSecondary: null, barcode: EAN_B },
    ],
    aliases: [{ barcode: "ENC-MAR-ALT", variantId: 101 }],
  },
  {
    id: 20, name: "Botella Smart", active: true, sku: null, barcode: null, price: 8500, randomSale: true,
    variants: [{ id: 201, name: "AZUL / ROSA", active: true, stock: 4, sku: "BOT-AZRO", colorHex: "#2563EB", colorHexSecondary: "#F472B6", barcode: EAN_C }],
    aliases: [],
  },
  { id: 30, name: "Soporte Notebook", active: true, sku: "SOP-NB", barcode: "BX-SOP-000030", price: 25000, randomSale: false, variants: [], aliases: [] },
  {
    id: 7, name: "APOYABRAZOS DE ESCRITORIO ERGONÓMICO 360°", active: true, sku: null, barcode: null, price: null, randomSale: false,
    variants: [{ id: 7, name: "NEGRO", active: true, stock: 1, sku: "AP01", colorHex: "#000000", colorHexSecondary: null, barcode: "6917116316809" }],
    aliases: [],
  },
]

function queueItem(productId: number, variantId: number | null, copies: number): LabelQueueItem {
  const product = CATALOG.find((item) => item.id === productId)
  const target = product && buildLabelTargets(product).targets.find((item) => item.variantId === variantId)
  const created = target && createQueueItem(target, target.options[0].code, copies)
  assert.ok(created)
  return created
}

const QUEUE = [queueItem(10, 101, 5), queueItem(10, 102, 3), queueItem(20, 201, 4)]
const PATTERNS = Object.fromEntries([EAN_A, EAN_B, EAN_C, "BX-SOP-000030"].map((code) => [code, encodeBarcodePattern(code)]))

const entry = `
import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { AdminEtiquetas } from "@/app/admin/sections/etiquetas/admin-etiquetas"
const catalog = ${JSON.stringify(CATALOG)}
const patterns = ${JSON.stringify(PATTERNS)}
window.__calls = []
window.fetch = async (input, init) => {
  const url = new URL(String(input), "http://admin.test")
  const body = init && init.body ? JSON.parse(init.body) : null
  window.__calls.push({ path: url.pathname + url.search, method: (init && init.method) || "GET", body })
  if (url.pathname === "/api/admin/labels/config") {
    if (init && init.method === "PUT") return Response.json({ settings: body.settings })
    return Response.json({ presets: [], preference: null, batches: [], storageUnavailable: false })
  }
  if (url.pathname === "/api/admin/labels/catalog") {
    const ids = url.searchParams.get("ids")
    if (ids) return Response.json({ items: catalog.filter((item) => ids.split(",").includes(String(item.id))), hasMore: false })
    const q = (url.searchParams.get("q") || "").toLowerCase()
    return Response.json({ items: catalog.filter((item) => item.name.toLowerCase().includes(q)), hasMore: false })
  }
  if (url.pathname === "/api/admin/labels/patterns") {
    return Response.json({ patterns: Object.fromEntries(body.codes.map((code) => [code, patterns[code]])), errors: {} })
  }
  if (url.pathname === "/api/admin/labels/batches") {
    return Response.json({ batch: { id: "00000000-0000-4000-8000-000000000001", name: body.name, labelCount: body.items.reduce((sum, item) => sum + item.copies, 0), output: body.output, createdAt: "2026-10-09T12:00:00.000Z", items: body.items } })
  }
  return Response.json({})
}
createRoot(document.getElementById("root")).render(createElement(AdminEtiquetas))
`

let browser: Browser
let css: string
let bundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx", sourcefile: "admin-labels-entry.tsx" },
    bundle: true, format: "iife", write: false, jsx: "automatic", plugins: [adminConfigStubs],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  })
  bundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

async function open(theme: "dark" | "light", width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, acceptDownloads: true })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const state = window as typeof window & { __labelPrintCalls?: number }
    state.__labelPrintCalls = 0
    window.addEventListener("message", (event) => {
      if (event.data === "beyonix-label-print-test") state.__labelPrintCalls = (state.__labelPrintCalls ?? 0) + 1
    })
    window.print = () => window.parent.postMessage("beyonix-label-print-test", "*")
  })
  await page.addInitScript(([key, queue]) => {
    window.localStorage.setItem(key, queue)
  }, [LABEL_QUEUE_STORAGE_KEY, JSON.stringify(QUEUE)] as const)
  await page.route("**/*", (route) =>
    route.request().url() === "http://admin.test/"
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: adminPageHtml(theme, css, bundle) })
      : route.abort(),
  )
  await page.goto("http://admin.test/")
  try {
    await page.getByRole("heading", { name: "Etiquetas", exact: true }).waitFor({ timeout: 10_000 })
    await page.getByRole("table", { name: "Productos para etiquetas" }).waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

test("selección compacta: variantes, cantidades válidas y regreso sin perder estado", async () => {
  const page = await open("dark")
  try {
    const print = page.getByRole("button", { name: "Imprimir etiquetas" })
    await print.waitFor()
    assert.equal(await print.isEnabled(), true, "la selección persistida habilita la acción")
    await page.getByLabel("Buscar productos y variantes").fill("Encendedor")
    const rows = page.getByRole("table", { name: "Productos para etiquetas" }).locator("tbody tr")
    await page.getByText("MARRÓN").first().waitFor()
    await page.waitForFunction(() => document.querySelectorAll('table[aria-label="Productos para etiquetas"] tbody tr').length === 3)
    assert.equal(await rows.count(), 3, "dos variantes y la selección adicional se muestran por fila")
    const brown = rows.filter({ hasText: EAN_A }).first()
    const black = rows.filter({ hasText: EAN_B }).first()
    assert.match(await brown.innerText(), /ENC-MAR/)
    assert.match(await black.innerText(), /ENC-NEG/)
    await brown.getByRole("spinbutton").fill("0")
    await brown.getByRole("button", { name: /Confirmar etiquetas/ }).click()
    await brown.getByRole("alert").waitFor()
    await brown.getByRole("spinbutton").fill("")
    await brown.getByRole("button", { name: /Confirmar etiquetas/ }).click()
    await brown.getByRole("alert").waitFor()
    await brown.getByRole("spinbutton").fill("1.5")
    await brown.getByRole("button", { name: /Confirmar etiquetas/ }).click()
    await brown.getByRole("alert").waitFor()
    await brown.getByRole("spinbutton").fill("2")
    await brown.getByRole("button", { name: /Confirmar etiquetas/ }).click()
    await brown.getByText("2", { exact: true }).last().waitFor()
    await page.getByLabel("Buscar productos y variantes").fill("Soporte")
    const support = page.getByRole("table", { name: "Productos para etiquetas" }).locator("tbody tr").filter({ hasText: "SOP-NB" })
    await support.waitFor()
    await support.getByRole("spinbutton").fill("2")
    await support.getByRole("button", { name: /Confirmar etiquetas/ }).click()
    await print.click()
    await page.getByRole("heading", { name: "Configurar impresión" }).waitFor()
    assert.equal(await page.getByRole("table", { name: "Productos para etiquetas" }).count(), 0)
    await page.getByRole("button", { name: "Estándar 50 × 25 mm" }).click()
    await page.getByRole("button", { name: "Continuar" }).click()
    await page.getByRole("heading", { name: "Previsualización" }).waitFor()
    const sheet = page.locator("svg[aria-label^='Vista previa de la hoja']").first()
    await sheet.waitFor()
    assert.equal(await sheet.locator("g[role='button']").count(), 11)
    assert.equal(await sheet.locator("g[role='button'] > svg").first().getAttribute("width"), "50")
    assert.match(await sheet.innerHTML(), /MARRÓN/)
    assert.match(await sheet.innerHTML(), /NEGRO/)
    assert.match(await sheet.innerHTML(), /7790001000019/)
    assert.match(await sheet.innerHTML(), /7790895000997/)
    await page.getByRole("button", { name: "Volver", exact: true }).click()
    await page.getByRole("heading", { name: "Configurar impresión" }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Estándar 50 × 25 mm" }).getAttribute("aria-pressed"), "true")
    await page.getByRole("button", { name: "Volver a productos" }).click()
    await page.getByRole("table", { name: "Productos para etiquetas" }).waitFor()
    await page.getByRole("table", { name: "Productos para etiquetas" }).locator("tbody tr").filter({ hasText: "SOP-NB" }).getByText("2", { exact: true }).last().waitFor()
  } finally { await page.close() }
})

test("A4: vista previa y PDF usan la misma tanda", async () => {
  const page = await open("light")
  try {
    await page.getByRole("button", { name: "Imprimir etiquetas" }).click()
    await page.getByRole("button", { name: "Continuar" }).click()
    const sheet = page.locator("svg[aria-label^='Vista previa de la hoja']").first()
    await sheet.waitFor()
    assert.equal(await sheet.locator("g[role='button']").count(), 12)
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Descargar PDF" }).first().click()])
    const path = await download.path()
    assert.ok(path)
    const pdf = await PDFDocument.load(readFileSync(path))
    assert.equal(pdf.getPageCount(), 1)
    const a4 = pdf.getPage(0).getSize()
    assert.ok(Math.abs(a4.width - 595.28) < 0.01 && Math.abs(a4.height - 841.89) < 0.01)
    await page.getByRole("button", { name: "Imprimir", exact: true }).first().click()
    await page.waitForFunction(() => (window as typeof window & { __labelPrintCalls?: number }).__labelPrintCalls === 1)
    await page.getByText("Enviadas 12 etiquetas al diálogo de impresión.").waitFor()
    await page.getByRole("button", { name: "Volver", exact: true }).click()
    await page.getByRole("button", { name: "Volver a productos" }).click()
    await page.getByRole("button", { name: /Tandas recientes/ }).click()
    await page.getByText("12 etiquetas · PDF", { exact: false }).waitFor()
  } finally { await page.close() }
})

test("rollo térmico: configuración progresiva, vista previa y ZPL", async () => {
  const page = await open("dark", 390)
  try {
    await page.getByRole("button", { name: "Imprimir etiquetas" }).click()
    await page.getByRole("button", { name: /^Rollo térmico/ }).click()
    await page.getByRole("button", { name: "Continuar" }).click()
    await page.locator("svg[aria-label^='Vista previa del rollo']").waitFor()
    assert.equal(await page.getByRole("button", { name: "Exportar ZPL" }).isEnabled(), true)
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar ZPL" }).click()])
    assert.match(download.suggestedFilename(), /\.zpl$/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  } finally { await page.close() }
})

test("rollo doble: cada variante conserva su código en dos columnas y en PDF", async () => {
  const page = await open("dark")
  try {
    await page.getByRole("button", { name: "Imprimir etiquetas" }).click()
    await page.getByRole("button", { name: /^Rollo térmico/ }).click()
    await page.getByLabel("Ancho (mm)").fill("100")
    await page.getByRole("button", { name: "Usar 2 de 49 mm" }).click()
    await page.getByRole("button", { name: "Continuar" }).click()
    const roll = page.locator("svg[aria-label^='Vista previa del rollo']")
    await roll.waitFor()
    const slots = roll.locator("g[role='button'] > svg")
    assert.equal(await slots.count(), 12)
    assert.equal(await slots.first().getAttribute("y"), await slots.nth(1).getAttribute("y"))
    assert.ok(Math.abs(Number(await slots.nth(1).getAttribute("x")) - Number(await slots.first().getAttribute("x")) - 51) < 0.01)
    assert.match(await roll.innerHTML(), /7790001000019/)
    assert.match(await roll.innerHTML(), /7790895000997/)
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Descargar PDF" }).first().click()])
    const path = await download.path()
    assert.ok(path)
    const pdf = await PDFDocument.load(readFileSync(path))
    assert.equal(pdf.getPageCount(), 6, "dos etiquetas por fila")
    const size = pdf.getPage(0).getSize()
    assert.ok(Math.abs(size.width - (100 * 72) / 25.4) < 0.01)
    assert.ok(Math.abs(size.height - (20 * 72) / 25.4) < 0.01)
  } finally { await page.close() }
})

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 768, 390]) {
    test(`${theme} ${width}px: códigos, select de Admin y cursor de eliminar`, async () => {
      const page = await open(theme, width)
      try {
        const table = page.getByRole("table", { name: "Productos para etiquetas" })
        await page.getByLabel("Buscar productos y variantes").fill("APOYABRAZOS")
        const armrest = table.locator("tbody tr").filter({ hasText: "AP01" })
        await armrest.waitFor()
        assert.equal((await armrest.locator("td").nth(2).innerText()).trim(), "AP01")
        assert.equal((await armrest.locator("td").nth(3).innerText()).trim(), "6917116316809")
        assert.equal(await armrest.getByRole("button", { name: /Código de barras/ }).count(), 0, "un barcode real no ofrece el SKU como alternativa")
        await page.getByLabel("Buscar productos y variantes").fill("Encendedor")
        const brown = table.locator("tbody tr").filter({ hasText: "MARRÓN" })
        const select = brown.getByRole("button", { name: /Código de barras/ })
        await select.waitFor()
        assert.match(await select.getAttribute("class") ?? "", /admin-control-select/)
        const style = await select.evaluate((element) => {
          const computed = getComputedStyle(element)
          return { height: element.getBoundingClientRect().height, background: computed.backgroundColor, border: computed.borderColor, radius: computed.borderRadius }
        })
        assert.ok(style.height >= 32 && style.height <= 48)
        assert.ok(style.background !== "rgba(0, 0, 0, 0)" && style.border !== "rgba(0, 0, 0, 0)" && style.radius !== "0px")
        await select.focus()
        await page.keyboard.press("ArrowDown")
        const options = page.getByRole("listbox", { name: /Código de barras/ }).getByRole("option")
        assert.deepEqual(await options.allTextContents(), [EAN_A, "ENC-MAR-ALT"])
        await options.first().focus()
        await page.keyboard.press("ArrowDown")
        await page.keyboard.press("Enter")
        assert.match(await select.innerText(), /ENC-MAR-ALT/)
        assert.equal(await brown.getByRole("button", { name: /Quitar/ }).evaluate((element) => getComputedStyle(element).cursor), "pointer")
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      } finally { await page.close() }
    })
  }
  test(`${theme}: el listado en móvil mantiene el scroll dentro de la tabla`, async () => {
    const page = await open(theme, 390)
    try {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      const table = page.getByRole("table", { name: "Productos para etiquetas" })
      assert.equal(await table.evaluate((element) => element.getBoundingClientRect().width > innerWidth), true)
      assert.equal(await table.evaluate((element) => element.parentElement!.scrollWidth > element.parentElement!.clientWidth), true)
    } finally { await page.close() }
  })
}
