import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import test from "node:test"
import { build } from "esbuild"
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library"
import { chromium, type Browser, type Page } from "playwright-core"

import { buildLabelsDocument } from "../barcodes/labels-document.ts"
import { renderCode128Svg } from "../barcodes/render.ts"
import { buildLocalDeliveryLabels, LocalDeliveryLabelError, type LocalDeliveryLabel, type LocalDeliveryLabelOrder } from "./local-delivery-label.ts"
import { LOCAL_DELIVERY_LABEL_TOO_LONG, localDeliveryCityLine } from "./local-delivery-label-layout.ts"

// Etiqueta Envío BEYONIX 101,6 × 50,8 mm maquetada por Chromium con el HTML
// real de impresión y el Code 128 real (bwip-js): ningún dato de entrega queda
// cortado en ningún caso que se genera, el barcode conserva zona de silencio y
// alto, y se decodifica (ZXing) a ~203 dpi, la resolución de la térmica.
// LABEL_SCREENSHOTS_DIR=<dir> guarda una captura por caso.

// pngjs llega con qrcode (dependencia directa) y no publica tipos.
const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } } }

const MM_TO_PX = 96 / 25.4
/** 2,12 px CSS → ~203 dpi. */
const PRINTER_SCALE = 203 / 96
const DEFINED_AT = "2026-11-03T15:30:00.000Z"
const BASE: LocalDeliveryLabelOrder = {
  id: 1041, cliente_nombre: "María José Peña", cliente_direccion: "Córdoba 1234 Piso 3 Dto B. Referencias: Portón verde, timbre 2",
  localidad: "Rosario", provincia: "Santa Fe", cp_destino: "2000", cliente_telefono: "341 555-0000",
}
const LONG_NAME = "María de los Ángeles Fernández Echeverría Ñúñez de la Santísima Trinidad"
const LONG_ADDRESS = "Avenida Presidente Domingo Faustino Sarmiento 12345 Piso 14 Departamento B Torre Norte"
const LONG_REFERENCE = "Entre Bv. Oroño y Balcarce, portón de rejas verde al lado de la farmacia, tocar timbre 2B y esperar"
const LONG_PHONE = "+54 9 341 555-0000 int. 1234 / 341 15 555-1111"
const address = (street: string, reference?: string) => reference ? `${street}. Referencias: ${reference}` : street

const parcels = (count: number, prefix = "BX-PKG-2041") => Array.from({ length: count }, (_, index) => ({
  barcode: `${prefix}-${String(index + 1).padStart(2, "0")}`, parcel_index: index + 1, parcel_count: count,
}))

const CASES: Array<{ name: string; order: LocalDeliveryLabelOrder; parcels?: ReturnType<typeof parcels> }> = [
  { name: "normal", order: BASE },
  { name: "varios-bultos", order: BASE, parcels: parcels(3) },
  { name: "rearmado-50-bultos", order: { ...BASE, id: 98765 }, parcels: parcels(50, "BX-PKG-99765-R12") },
  { name: "nombre-corto", order: { ...BASE, cliente_nombre: "Ana" } },
  { name: "nombre-largo", order: { ...BASE, cliente_nombre: LONG_NAME } },
  { name: "direccion-corta", order: { ...BASE, cliente_direccion: "Mitre 10" } },
  { name: "direccion-larga", order: { ...BASE, cliente_direccion: address(LONG_ADDRESS, "Portón verde") } },
  { name: "referencia-corta", order: { ...BASE, cliente_direccion: address("Oroño 55", "Casa") } },
  { name: "referencia-larga", order: { ...BASE, cliente_direccion: address("Oroño 55", LONG_REFERENCE) } },
  { name: "localidad-larga", order: { ...BASE, localidad: "Villa Gobernador Gálvez", provincia: "Ciudad Autónoma de Buenos Aires" } },
  { name: "telefono-largo", order: { ...BASE, cliente_telefono: LONG_PHONE } },
  { name: "sin-telefono-ni-referencia", order: { ...BASE, cliente_telefono: null, cliente_direccion: "Mitre 10" } },
  {
    name: "extremo-combinado",
    order: { ...BASE, cliente_nombre: LONG_NAME, cliente_direccion: address(LONG_ADDRESS, LONG_REFERENCE), localidad: "Villa Gobernador Gálvez", provincia: "Santa Fe", cliente_telefono: LONG_PHONE },
  },
  {
    // Dirección y referencia el doble de largas: entra en el escalón mínimo legible.
    name: "extremo-doble",
    order: { ...BASE, cliente_nombre: LONG_NAME, cliente_direccion: address(`${LONG_ADDRESS} ${LONG_ADDRESS}`, `${LONG_REFERENCE} ${LONG_REFERENCE}`), cliente_telefono: LONG_PHONE },
  },
]

let browser: Browser
let guardBundle: string
const screenshotsDir = process.env.LABEL_SCREENSHOTS_DIR

test.before(async () => {
  const result = await build({
    stdin: { contents: `import { findClippedLocalDeliveryLabel } from "./lib/barcodes/labels-document.ts"; window.__findClipped = findClippedLocalDeliveryLabel`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, format: "iife", write: false, logLevel: "error",
  })
  guardBundle = result.outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  if (screenshotsDir) mkdirSync(screenshotsDir, { recursive: true })
})

test.after(async () => { await browser?.close() })

function documentFor(labels: LocalDeliveryLabel[]) {
  const svgs = Object.fromEntries(labels.map((label) => [label.code, renderCode128Svg(label.code)]))
  return buildLabelsDocument(labels, svgs, "single")
}

async function openDocument(html: string) {
  const page = await browser.newPage({ viewport: { width: 420, height: 400 }, deviceScaleFactor: PRINTER_SCALE })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  await page.setContent(html)
  await page.addScriptTag({ content: guardBundle })
  return { page, errors }
}

function decodeCode128(png: Buffer) {
  const image = PNG.sync.read(png)
  const luminance = new Uint8ClampedArray(image.width * image.height)
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4
    luminance[index] = (image.data[offset] * 299 + image.data[offset + 1] * 587 + image.data[offset + 2] * 114) / 1000
  }
  const reader = new MultiFormatReader()
  reader.setHints(new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]], [DecodeHintType.TRY_HARDER, true]]))
  return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminance, image.width, image.height)))).getText()
}

type Measured = {
  size: { width: number; height: number }
  overflow: Array<{ field: string; text: string }>
  values: Record<string, string>
  truncating: string[]
  barcode: { left: number; right: number; height: number; labelLeft: number; labelRight: number }
}

const measure = (page: Page, index: number) => page.locator(".label.local_delivery").nth(index).evaluate((label): Measured => {
  const box = label.getBoundingClientRect()
  const body = label.querySelector(".ld-body")!.getBoundingClientRect()
  const overflow = [...label.querySelectorAll<HTMLElement>(".ld-value, .ld-label, .ld-head > *, .ld-foot > *")]
    .filter((element) => {
      const rect = element.getBoundingClientRect()
      const area = element.closest(".ld-body") ? body : box
      return rect.bottom > area.bottom + 0.5 || rect.right > area.right + 0.5 || rect.top < area.top - 0.5 || rect.left < area.left - 0.5 ||
        element.scrollWidth > element.clientWidth + 1
    })
    .map((element) => ({ field: element.className, text: element.textContent ?? "" }))
  const values = Object.fromEntries([...label.querySelectorAll<HTMLElement>(".ld-value")].map((element) => [element.classList[1], element.textContent ?? ""]))
  // Ni ellipsis, ni line-clamp, ni zonas que recorten la tinta (acentos de Á/Ñ en la primera línea).
  const truncating = [...label.querySelectorAll<HTMLElement>("*")].filter((element) => {
    const style = getComputedStyle(element)
    return style.textOverflow === "ellipsis" || (style.webkitLineClamp !== "none" && style.webkitLineClamp !== "") ||
      (element.matches(".ld-head, .ld-head *, .ld-body, .ld-body *, .ld-foot, .ld-foot *") && style.overflow !== "visible")
  }).map((element) => element.className)
  const svg = label.querySelector(".barcode svg")!.getBoundingClientRect()
  return {
    size: { width: box.width, height: box.height }, overflow, values, truncating,
    barcode: { left: svg.left, right: svg.right, height: svg.height, labelLeft: box.left, labelRight: box.right },
  }
})

for (const item of CASES) {
  test(`etiqueta ${item.name}: 101,6 × 50,8 mm, todos los datos completos y visibles, Code 128 decodificable`, async () => {
    const labels = buildLocalDeliveryLabels(item.order, item.parcels ?? parcels(1), DEFINED_AT)
    const { page, errors } = await openDocument(documentFor(labels))
    try {
      assert.equal(await page.evaluate(() => (window as unknown as { __findClipped(document: Document): string | null }).__findClipped(document)), null)
      const checked = labels.length > 3 ? [0, labels.length - 1] : labels.map((_, index) => index)
      for (const index of checked) {
        const label = labels[index]
        const measured = await measure(page, index)
        assert.ok(Math.abs(measured.size.width - 101.6 * MM_TO_PX) < 1 && Math.abs(measured.size.height - 50.8 * MM_TO_PX) < 1, JSON.stringify(measured.size))
        assert.deepEqual(measured.overflow, [], `${item.name} ${label.code}: nada fuera de su zona`)
        assert.deepEqual(measured.truncating, [], "sin ellipsis ni line-clamp")
        // Texto COMPLETO de cada dato de entrega (nada recortado por código).
        assert.equal(measured.values["ld-recipient"], label.recipient)
        assert.equal(measured.values["ld-address"], label.address)
        assert.equal(measured.values["ld-reference"], label.reference ?? undefined)
        assert.equal(measured.values["ld-city"], localDeliveryCityLine(label))
        assert.equal(measured.values["ld-phone"], label.phone ?? "—")
        // Zona de silencio ≥ 7 mm a cada lado y barras de 9 mm.
        assert.ok(measured.barcode.left - measured.barcode.labelLeft >= 9 * MM_TO_PX, "zona de silencio izquierda")
        assert.ok(measured.barcode.labelRight - measured.barcode.right >= 9 * MM_TO_PX, "zona de silencio derecha")
        assert.ok(Math.abs(measured.barcode.height - 9 * MM_TO_PX) < 1, "alto de barras")
        const labelLocator = page.locator(".label.local_delivery").nth(index)
        assert.equal(decodeCode128(await labelLocator.locator(".barcode").screenshot()), label.code, "Code 128 decodificable a ~203 dpi")
        assert.match(await labelLocator.locator(".ld-head").innerText(), new RegExp(`BULTO ${label.index}/${label.count}`))
        if (screenshotsDir) writeFileSync(join(screenshotsDir, `etiqueta-${item.name}-${label.index}de${label.count}.png`), await labelLocator.screenshot())
      }
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("caso que no entra legible: no se genera ni se imprime (mensaje claro)", () => {
  const absurd = { ...BASE, cliente_nombre: LONG_NAME, cliente_direccion: address(`${LONG_ADDRESS} `.repeat(4).trim(), `${LONG_REFERENCE} `.repeat(4).trim()), cliente_telefono: LONG_PHONE }
  assert.throws(() => buildLocalDeliveryLabels(absurd, parcels(1), DEFINED_AT), (error: Error) =>
    error instanceof LocalDeliveryLabelError && error.message === LOCAL_DELIVERY_LABEL_TOO_LONG)
})

test("barrera de impresión: también dentro del iframe 0×0 de impresión detecta cualquier recorte y bloquea", async () => {
  const html = documentFor(buildLocalDeliveryLabels(BASE, parcels(2), DEFINED_AT))
  const page = await browser.newPage()
  try {
    await page.setContent("<!doctype html><html><body></body></html>")
    await page.addScriptTag({ content: guardBundle })
    const outcome = await page.evaluate(async (source) => {
      const frame = document.createElement("iframe")
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none"
      const loaded = new Promise((resolve) => { frame.onload = resolve })
      frame.srcdoc = source
      document.body.appendChild(frame)
      await loaded
      const guard = (window as unknown as { __findClipped(document: Document): string | null }).__findClipped
      const target = frame.contentDocument!
      const clean = guard(target)
      target.querySelector(".ld-address")!.textContent = "Calle con muchísimo texto ".repeat(40)
      const clipped = guard(target)
      return { clean, clipped }
    }, html)
    assert.deepEqual(outcome, { clean: null, clipped: LOCAL_DELIVERY_LABEL_TOO_LONG })
  } finally { await page.close() }
})
