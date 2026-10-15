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
// APIs simuladas. Flujo en 3 pasos: productos (−/+ directo en cada fila) →
// formato → vista previa e impresión. Caso real: Encendedor Marrón ×5,
// Negro ×3, Botella ×4 y Soporte ×2 = 14 etiquetas de 40×20 → una hoja A4;
// rollo térmico 80 × 20 de 2 columnas; PDF/ZPL; layout desktop y mobile.

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
    await page.locator("[data-label-total]", { hasText: "12 etiquetas" }).waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.close()
    throw new Error(`No renderizó: ${errors.join(" | ") || String(error)}`)
  }
  return page
}

const step = (page: Page, name: RegExp) => page.getByRole("navigation", { name: /Pasos/ }).getByRole("button", { name }).click()
const toFormat = (page: Page) => step(page, /^Formato/)
const toPrint = async (page: Page) => {
  await step(page, /^Vista previa e impresión/)
  await page.getByText(/^Lista para imprimir:/).waitFor()
}
const metric = (page: Page, label: string) => page.locator(`[data-label-metric='${label}']`).innerText()
const sheetSelector = "svg[aria-label^='Vista previa de la hoja']"

test("caso real: armar la tanda con −/+, 14 etiquetas de 40×20 en una hoja A4, ajuste en vivo y etiqueta ampliada", async () => {
  const page = await open("dark")
  try {
    // Paso 1: lo agregado se ve en la propia fila; la cantidad se elige con −/+.
    await page.getByLabel("Buscar productos").fill("Soporte")
    await page.getByRole("button", { name: "Agregar Soporte Notebook" }).click()
    await page.getByRole("button", { name: "Sumar una etiqueta de Soporte Notebook" }).first().click()
    assert.equal(await page.getByLabel("Cantidad de etiquetas de Soporte Notebook").first().inputValue(), "2")

    await page.getByLabel("Buscar productos").fill("Encendedor")
    await page.locator("li[data-selected='true']", { hasText: "NEGRO · ENC-NEG" }).waitFor()
    const negro = page.getByLabel("Cantidad de etiquetas de Encendedor USB NEGRO").first()
    assert.equal(await negro.inputValue(), "3", "la fila muestra lo que ya está en la tanda")
    await page.getByRole("button", { name: "Sumar una etiqueta de Encendedor USB NEGRO" }).first().click()
    await page.getByRole("button", { name: "Restar una etiqueta de Encendedor USB NEGRO" }).first().click()
    assert.equal(await page.locator("li[data-selected='true']").count(), 2, "las dos variantes del encendedor figuran agregadas")
    assert.match(await page.locator("li[data-selected='true']").first().innerText(), /MARRÓN · ENC-MAR/, "COLOR · SKU de un vistazo")
    await page.locator("[data-label-total]", { hasText: "14 etiquetas" }).waitFor()
    // La tanda dice dónde cae cada artículo.
    await page.locator("[data-label-placement]", { hasText: "Etiquetas 6–8 · hoja 1" }).waitFor()

    // Paso 2 → 3.
    await page.getByRole("button", { name: /Continuar: elegir formato/ }).click()
    await page.getByRole("button", { name: /Ver e imprimir/ }).click()
    await page.getByText(/^Lista para imprimir:/).waitFor()
    assert.equal(await metric(page, "Etiquetas"), "14")
    assert.equal(await metric(page, "Por hoja"), "48 (4 × 12)")
    assert.equal(await metric(page, "Hojas"), "1")
    const sheet = page.locator(sheetSelector).first()
    await sheet.locator("path").first().waitFor()
    assert.equal(await sheet.locator("g[role='button']").count(), 14, "14 etiquetas dibujadas, en el orden de la tanda")
    assert.equal(await sheet.getAttribute("viewBox"), "0 0 210 297", "hoja A4 en mm")
    const firstLabel = sheet.locator("g[role='button'] > svg").first()
    assert.equal(await firstLabel.getAttribute("width"), "40")
    assert.equal(await firstLabel.getAttribute("height"), "20")
    assert.match(await sheet.locator("g[role='button']").first().innerHTML(), /MARRÓN · ENC-MAR/, "línea 2: COLOR · SKU")
    assert.match(await sheet.locator("g[role='button']").nth(13).getAttribute("aria-label") ?? "", /Soporte Notebook/)

    // Ajuste en vivo: 40×20 → 50×25.
    await toFormat(page)
    await page.getByRole("radio", { name: /A4 · 50 × 25/ }).click()
    await page.locator("[data-format-layout]", { hasText: "3 col. × 10 filas = 30 por hoja" }).waitFor()
    // Medida personalizada; inválida no se aplica.
    await page.getByLabel("Ancho (mm)").fill("0")
    await page.getByText("Ancho: entre 20 mm y 120 mm.").waitFor()
    assert.match(await page.locator("[data-format-name]").innerText(), /50 × 25/, "0 mm no se aplica")
    await page.getByLabel("Ancho (mm)").fill("40")
    await page.getByLabel("Alto (mm)").fill("20")
    await page.locator("[data-format-name]", { hasText: "A4 · 40 × 20" }).waitFor()
    await toPrint(page)
    await page.waitForFunction((selector) => document.querySelector(`${selector} g[role='button'] > svg`)?.getAttribute("height") === "20", sheetSelector)

    // Etiqueta ampliada con medidas reales.
    await page.locator(sheetSelector).locator("g[role='button']").first().click()
    const dialog = page.getByRole("dialog", { name: "Etiqueta ampliada" })
    await dialog.waitFor()
    await dialog.getByText("40 × 20 mm", { exact: true }).waitFor()
    await dialog.getByText("EAN-13", { exact: true }).waitFor()
    await dialog.locator("li", { hasText: EAN_A }).waitFor()
    await dialog.getByRole("button", { name: "Cerrar" }).first().click()

    // Formato recordado en la cuenta (debounce).
    await page.waitForFunction(() => (window as unknown as { __calls: { path: string; method: string }[] }).__calls.some((call) => call.path === "/api/admin/labels/config" && call.method === "PUT"), null, { timeout: 5000 })
  } finally {
    await page.close()
  }
})

test("PDF: se descarga con tamaño físico A4 y la tanda queda en el historial", async () => {
  const page = await open("light")
  try {
    await toPrint(page)
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Descargar PDF" }).click(),
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
    await step(page, /^Productos/)
    await page.getByText(/Tandas recientes/).click()
    await page.getByText("12 etiquetas · PDF", { exact: false }).waitFor()
  } finally {
    await page.close()
  }
})

test("rollo térmico 80 × 20 de 2 columnas: preview por filas, métricas y ZPL", async () => {
  const page = await open("dark")
  try {
    await toFormat(page)
    await page.getByRole("radio", { name: /Rollo térmico/ }).click()
    await page.getByRole("radio", { name: /Rollo 80 × 20/ }).click()
    await page.locator("[data-roll-summary]", { hasText: "Cada fila del rollo mide 80 × 20 mm y lleva 2 etiquetas de 39 × 20 mm." }).waitFor()
    assert.equal(await page.getByRole("radio", { name: /Rollo 80 × 20/ }).getAttribute("aria-checked"), "true")
    assert.equal(await page.getByRole("radio", { name: "2", exact: true }).getAttribute("aria-checked"), "true")

    await toPrint(page)
    assert.equal(await metric(page, "Por fila"), "2")
    assert.equal(await metric(page, "Filas"), "6", "12 etiquetas / 2 columnas")
    assert.equal(await metric(page, "Largo de rollo"), `${((6 * 20 + 5 * 3) / 10).toLocaleString("es-AR")} cm`)
    const roll = page.locator("svg[aria-label^='Vista previa del rollo']")
    assert.match(await roll.getAttribute("aria-label") ?? "", /12 etiquetas en 6 filas/)
    const [left, right] = await roll.locator("g[role='button'] > svg").evaluateAll((nodes) => nodes.slice(0, 2).map((node) => ["x", "y", "width"].map((name) => Number(node.getAttribute(name)))))
    assert.equal(left[1], right[1], "las dos etiquetas comparten la fila")
    assert.equal(Math.round((right[0] - left[0]) * 10) / 10, 41, "39 mm + 2 mm de separación")
    assert.equal(left[2], 39)

    const zpl = page.getByRole("button", { name: "Exportar ZPL" })
    assert.equal(await zpl.isDisabled(), false)
    const [download] = await Promise.all([page.waitForEvent("download"), zpl.click()])
    assert.match(download.suggestedFilename(), /\.zpl$/)
    const path = await download.path()
    assert.ok(path)
    assert.match(readFileSync(path, "utf8"), /\^PW639\n\^LL160/, "fila de 80 × 20 mm a 203 dpi")

    // 1 columna: una etiqueta por fila.
    await toFormat(page)
    await page.getByRole("radio", { name: "1", exact: true }).click()
    await toPrint(page)
    assert.equal(await metric(page, "Filas"), "12")
  } finally {
    await page.close()
  }
})

test("térmica 10 × 2 cm: 100 × 20 cargado como una etiqueta se divide en 2 columnas; vista previa, PDF y ZPL", async () => {
  const page = await open("light")
  try {
    await toFormat(page)
    await page.getByRole("radio", { name: /Rollo térmico/ }).click()
    await page.getByLabel("Ancho (mm)").fill("100")
    const suggestion = page.locator("[data-column-suggestion]")
    await suggestion.waitFor()
    await suggestion.getByRole("button", { name: "Usar 2 columnas" }).click()
    await page.locator("[data-roll-summary]", { hasText: "Cada fila del rollo mide 100 × 20 mm y lleva 2 etiquetas de 49 × 20 mm." }).waitFor()
    assert.equal(await page.getByRole("radio", { name: /Rollo 100 × 20/ }).getAttribute("aria-checked"), "true", "equivale al preset del rollo doble")

    await toPrint(page)
    assert.equal(await metric(page, "Por fila"), "2")
    assert.equal(await metric(page, "Filas"), "6")
    const slots = page.locator("svg[aria-label^='Vista previa del rollo'] g[role='button'] > svg")
    assert.equal(await slots.count(), 12, "6 filas × 2 en un solo tramo")
    const [left, right] = await slots.evaluateAll((nodes) => nodes.slice(0, 2).map((node) => ["x", "y", "width"].map((name) => Number(node.getAttribute(name)))))
    assert.equal(left[1], right[1], "las dos etiquetas comparten la fila")
    assert.equal(Math.round((right[0] - left[0]) * 10) / 10, 51, "49 mm + 2 mm de separación")
    assert.equal(left[2], 49)

    const [pdfDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Descargar PDF" }).click()])
    const pdfPath = await pdfDownload.path()
    assert.ok(pdfPath)
    const pdf = await PDFDocument.load(readFileSync(pdfPath))
    assert.equal(pdf.getPageCount(), 6, "una página por fila del rollo")
    const size = pdf.getPage(0).getSize()
    assert.ok(Math.abs(size.width - (100 * 72) / 25.4) < 0.01 && Math.abs(size.height - (20 * 72) / 25.4) < 0.01, "página = fila de 100 × 20 mm")

    const [zplDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar ZPL" }).click()])
    const zplPath = await zplDownload.path()
    assert.ok(zplPath)
    const zpl = readFileSync(zplPath, "utf8")
    assert.match(zpl, /\^PW799\n\^LL160/)
    assert.equal(zpl.split("^XZ")[0].match(/\^BEN/g)?.length, 2, "dos códigos por formato")
  } finally {
    await page.close()
  }
})

for (const width of [1366, 1440, 1920]) {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme} ${width}px: pasos en dos columnas y sin scroll horizontal`, async () => {
      const page = await open(theme, width)
      try {
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        const box = async (name: string) => {
          const section = page.locator("section", { has: page.getByRole("heading", { name, exact: true }) }).first()
          const rect = await section.boundingBox()
          assert.ok(rect, name)
          return rect
        }
        assert.ok((await overflow()) <= 0, "paso 1 sin scroll horizontal")
        const [search, batch] = await Promise.all([box("Buscar productos"), box("Tanda")])
        assert.ok(batch.x > search.x + search.width - 1, "la tanda va a la derecha de la búsqueda")

        await toFormat(page)
        const [format, sample] = await Promise.all([box("Formato de etiqueta"), box("Así queda")])
        assert.ok(sample.x > format.x + format.width - 1, "la muestra va a la derecha del formato")

        await toPrint(page)
        assert.ok((await overflow()) <= 0, "paso 3 sin scroll horizontal")
        const [preview, print] = await Promise.all([box("Vista previa"), box("Imprimir")])
        assert.ok(print.x > preview.x + preview.width - 1, "imprimir va a la derecha de la vista previa")
        const sheet = await page.locator(sheetSelector).first().boundingBox()
        assert.ok(sheet && sheet.width >= 280 && sheet.x + sheet.width <= preview.x + preview.width + 1)
        // Fondo de la etiqueta siempre blanco, también en oscuro.
        const fill = await page.locator(`${sheetSelector} g[role='button'] > svg > rect`).first().getAttribute("fill")
        assert.equal(fill, "#fff")
      } finally {
        await page.close()
      }
    })
  }
}

test("mobile 390px: los tres pasos en una columna, sin scroll horizontal", async () => {
  const page = await open("light", 390)
  try {
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok((await overflow()) <= 0, `paso 1: ${await overflow()}px`)
    await toFormat(page)
    assert.ok((await overflow()) <= 0, `paso 2: ${await overflow()}px`)
    await toPrint(page)
    assert.ok((await overflow()) <= 0, `paso 3: ${await overflow()}px`)
    await page.getByRole("button", { name: /^Imprimir 12 etiquetas/ }).waitFor()
  } finally {
    await page.close()
  }
})
