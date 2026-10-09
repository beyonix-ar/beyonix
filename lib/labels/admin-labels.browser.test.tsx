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

// Admin → Etiquetas con el componente REAL (AdminEtiquetas, bundle esbuild) y
// APIs simuladas. Caso real: Encendedor Marrón ×5, Negro ×3, Botella ×4 y
// Soporte ×2 = 14 etiquetas de 40×20 → una sola hoja A4. Ajuste en vivo,
// etiqueta ampliada, PDF con tamaño físico y layout en 1366/1440/1920.

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
    aliases: [],
  },
  {
    id: 20, name: "Botella Smart", active: true, sku: null, barcode: null, price: 8500, randomSale: true,
    variants: [{ id: 201, name: "AZUL / ROSA", active: true, stock: 4, sku: "BOT-AZRO", colorHex: "#2563EB", colorHexSecondary: "#F472B6", barcode: EAN_C }],
    aliases: [],
  },
  { id: 30, name: "Soporte Notebook", active: true, sku: "SOP-NB", barcode: "BX-SOP-000030", price: 25000, randomSale: false, variants: [], aliases: [] },
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
    await page.locator("svg[aria-label^='Vista previa de la hoja'] path").first().waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

const stat = (page: Page, label: string) =>
  page.locator("p", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::p[1]").innerText()

test("caso real: 14 etiquetas de 40×20 en una sola hoja A4, ajuste en vivo y etiqueta ampliada", async () => {
  const page = await open("dark")
  try {
    // Agregar el Soporte desde la búsqueda (server-side) y sumar un duplicado.
    await page.getByLabel("Buscar productos y variantes").fill("Soporte")
    const add = page.getByRole("button", { name: "Agregar Soporte Notebook a la cola" })
    await add.waitFor()
    await page.getByLabel("Cantidad de etiquetas de Soporte Notebook").fill("2")
    await add.click()
    await page.getByText("Agregado: Soporte Notebook ×2.").waitFor()
    await page.getByLabel("Buscar productos y variantes").fill("Encendedor")
    await page.getByLabel("Cantidad de etiquetas de NEGRO").fill("1")
    await page.getByRole("button", { name: "Agregar NEGRO a la cola" }).click()
    await page.getByText("Sumado: Encendedor USB · NEGRO ×1.").waitFor()
    await page.getByRole("button", { name: "Restar una etiqueta de Encendedor USB" }).nth(1).click()

    await page.getByText("4 artículos · 14 etiquetas").waitFor()
    assert.equal(await stat(page, "Etiquetas"), "14")
    assert.equal(await stat(page, "Por hoja"), "48 (4×12)")
    assert.equal(await stat(page, "Hojas"), "1")
    assert.equal(await stat(page, "Espacios libres"), "34")
    const sheet = page.locator("svg[aria-label^='Vista previa de la hoja']").first()
    assert.equal(await sheet.locator("g[role='button']").count(), 14, "14 etiquetas dibujadas, en el orden de la cola")
    assert.equal(await sheet.getAttribute("viewBox"), "0 0 210 297", "hoja A4 en mm")
    const firstLabel = sheet.locator("g[role='button'] > svg").first()
    assert.equal(await firstLabel.getAttribute("width"), "40")
    assert.equal(await firstLabel.getAttribute("height"), "20")
    assert.match(await sheet.locator("g[role='button']").first().innerHTML(), /MARRÓN/)
    assert.match(await sheet.locator("g[role='button']").nth(13).getAttribute("aria-label") ?? "", /Soporte Notebook/)

    // Ajuste en vivo: 40×20 → 50×25.
    await page.getByRole("button", { name: "Estándar 50 × 25 mm" }).click()
    await page.waitForFunction(() => document.querySelector("svg[aria-label^='Vista previa de la hoja'] g[role='button'] > svg")?.getAttribute("width") === "50")
    assert.equal(await stat(page, "Por hoja"), "30 (3×10)")
    // Medida personalizada; inválida no se aplica.
    await page.getByLabel("Ancho (mm)").fill("0")
    await page.getByText("Ancho: entre 20 mm y 120 mm.").waitFor()
    assert.equal(await firstLabel.getAttribute("width"), "50", "0 mm no se aplica")
    await page.getByLabel("Ancho (mm)").fill("40")
    await page.getByLabel("Alto (mm)").fill("20")
    await page.waitForFunction(() => document.querySelector("svg[aria-label^='Vista previa de la hoja'] g[role='button'] > svg")?.getAttribute("height") === "20")

    // Etiqueta ampliada con medidas reales.
    await sheet.locator("g[role='button']").first().click()
    const dialog = page.getByRole("dialog", { name: "Etiqueta ampliada" })
    await dialog.waitFor()
    await dialog.getByText("40 × 20 mm", { exact: true }).waitFor()
    await dialog.getByText("EAN-13", { exact: true }).waitFor()
    await dialog.locator("li", { hasText: EAN_A }).waitFor()
    await dialog.getByRole("button", { name: "Cerrar" }).first().click()

    // Preferencia recordada en la cuenta (debounce).
    await page.waitForFunction(() => (window as unknown as { __calls: { path: string; method: string }[] }).__calls.some((call) => call.path === "/api/admin/labels/config" && call.method === "PUT"), null, { timeout: 5000 })
  } finally {
    await page.close()
  }
})

test("PDF: se descarga con tamaño físico A4 y la tanda queda en el historial", async () => {
  const page = await open("light")
  try {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Descargar PDF" }).first().click(),
    ])
    assert.match(download.suggestedFilename(), /^etiquetas-beyonix-\d{8}-\d{4}\.pdf$/)
    const path = await download.path()
    assert.ok(path)
    const pdf = await PDFDocument.load(readFileSync(path))
    assert.equal(pdf.getPageCount(), 1, "12 etiquetas de 40×20 entran en una hoja")
    const { width, height } = pdf.getPage(0).getSize()
    assert.ok(Math.abs(width - 595.28) < 0.01 && Math.abs(height - 841.89) < 0.01)
    await page.getByText("Archivo PDF generado con 12 etiquetas.").waitFor()
    const calls = await page.evaluate(() => (window as unknown as { __calls: { path: string; method: string; body: { output?: string; items?: unknown[] } | null }[] }).__calls)
    const batch = calls.find((call) => call.path === "/api/admin/labels/batches")
    assert.equal(batch?.body?.output, "pdf")
    assert.equal(batch?.body?.items?.length, 3)
    await page.getByRole("button", { name: /Tandas recientes/ }).click()
    await page.getByText("12 etiquetas · PDF", { exact: false }).waitFor()
  } finally {
    await page.close()
  }
})

test("térmica: una etiqueta por página, rollo y ZPL disponible a 203 dpi", async () => {
  const page = await open("dark")
  try {
    await page.getByRole("button", { name: "Térmica", exact: true }).click()
    await page.locator("svg[aria-label^='Vista previa del rollo']").waitFor()
    assert.equal(await stat(page, "Por página"), "1")
    assert.equal(await stat(page, "DPI"), "203")
    assert.equal(await stat(page, "Largo de rollo"), `${((12 * 20 + 11 * 3) / 10).toLocaleString("es-AR")} cm`)
    const zpl = page.getByRole("button", { name: "Exportar ZPL" })
    assert.equal(await zpl.isDisabled(), false)
    const [download] = await Promise.all([page.waitForEvent("download"), zpl.click()])
    assert.match(download.suggestedFilename(), /\.zpl$/)
  } finally {
    await page.close()
  }
})

for (const width of [1366, 1440, 1920]) {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme} ${width}px: columnas ordenadas y sin scroll horizontal`, async () => {
      const page = await open(theme, width)
      try {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        assert.ok(overflow <= 0, `scroll horizontal de ${overflow}px`)
        const box = async (name: string) => {
          const section = page.locator("section", { has: page.getByRole("heading", { name, exact: true }) }).first()
          const rect = await section.boundingBox()
          assert.ok(rect, name)
          return rect
        }
        const [search, queue, preview] = await Promise.all([box("Buscar productos y variantes"), box("Cola de impresión"), box("Vista previa")])
        assert.ok(preview.x > search.x + search.width - 1, "la vista previa va a la derecha")
        if (width >= 1536) {
          assert.ok(queue.x > search.x + search.width - 1 && preview.x > queue.x + queue.width - 1, "tres columnas: buscar · cola · vista previa")
        } else {
          assert.ok(Math.abs(queue.x - search.x) < 2 && queue.y > search.y, "dos columnas: buscar y cola a la izquierda")
        }
        // La hoja se ve completa y legible dentro de su panel.
        const sheet = await page.locator("svg[aria-label^='Vista previa de la hoja']").first().boundingBox()
        assert.ok(sheet && sheet.width >= 280 && sheet.x + sheet.width <= preview.x + preview.width + 1)
        // Fondo de la etiqueta siempre blanco, también en oscuro.
        const fill = await page.locator("svg[aria-label^='Vista previa de la hoja'] g[role='button'] > svg > rect").first().getAttribute("fill")
        assert.equal(fill, "#fff")
      } finally {
        await page.close()
      }
    })
  }
}
