import assert from "node:assert/strict"
import test from "node:test"
import { PDFDocument } from "pdf-lib"

import { buildLabelTargets, type LabelCatalogProduct } from "./catalog.ts"
import { autoShortName, buildLabelDrawing, barcodeModuleWidth, sanitizeLabelText, wrapText, type BarcodePattern } from "./drawing.ts"
import { encodeBarcodePattern } from "./encode.ts"
import { defaultBatchName, parseBatchItems, parsePresetPayload, toBatchItems } from "./history.ts"
import { computeA4Grid, layoutNotices, planLabels } from "./layout.ts"
import { buildLabelsPdf } from "./pdf.ts"
import {
  addToQueue,
  changeQueueCode,
  createQueueItem,
  expandQueue,
  moveQueueItem,
  orderQueue,
  parseCopies,
  parseStoredQueue,
  queueLabelCount,
  reconcileQueue,
  removeFromQueue,
  setQueueCopies,
  setQueueLabelName,
  stepQueueCopies,
  type LabelQueueItem,
} from "./queue.ts"
import { buildPrintDocument, labelSvgMarkup, prepareBatch } from "./render.ts"
import { DEFAULT_LABEL_SETTINGS, MAX_BATCH_LABELS, matchSizePreset, measureError, normalizeLabelSettings, type LabelSettings } from "./settings.ts"
import { classifyBarcode, gtinCheckDigit, isValidGtin } from "./symbology.ts"
import { buildZpl, zplUnavailableReason } from "./zpl.ts"

// EAN-13 válidos (dígito verificador real).
const EAN_A = "7790001000019"
const EAN_B = "7790895000997"
const EAN_C = "7891000315507"

const settings = (patch: Partial<LabelSettings> = {}): LabelSettings => normalizeLabelSettings({ ...DEFAULT_LABEL_SETTINGS, ...patch })

const lighter: LabelCatalogProduct = {
  id: 10,
  name: "Encendedor USB Recargable (plasma) - Edición 2026",
  active: true,
  sku: null,
  barcode: null,
  price: 12999,
  randomSale: false,
  variants: [
    { id: 101, name: "MARRÓN", active: true, stock: 5, sku: "ENC-MAR", colorHex: "#8B5A2B", colorHexSecondary: null, barcode: EAN_A },
    { id: 102, name: "NEGRO", active: true, stock: 3, sku: "ENC-NEG", colorHex: "#000000", colorHexSecondary: null, barcode: EAN_B },
  ],
  aliases: [{ barcode: "ENC-MAR-ALT", variantId: 101 }, { barcode: "7790000000000", variantId: null }],
}

const bottle: LabelCatalogProduct = {
  id: 20,
  name: "Botella Smart",
  active: true,
  sku: null,
  barcode: null,
  price: null,
  randomSale: true,
  variants: [
    { id: 201, name: "AZUL / ROSA", active: true, stock: 4, sku: "BOT-AZRO", colorHex: "#2563EB", colorHexSecondary: "#F472B6", barcode: EAN_C },
    { id: 202, name: "ROJO", active: true, stock: 2, sku: "BOT-ROJ", colorHex: "#EF4444", colorHexSecondary: null, barcode: "BX-BOT-000202" },
    { id: 203, name: "VERDE", active: false, stock: 0, sku: null, colorHex: "#22C55E", colorHexSecondary: null, barcode: null },
  ],
  aliases: [{ barcode: "GRUPO-BOTELLA", variantId: null }],
}

const stand: LabelCatalogProduct = {
  id: 30,
  name: "Soporte Notebook",
  active: true,
  sku: "SOP-NB",
  barcode: "BX-SOP-000030",
  price: 25000,
  randomSale: false,
  variants: [],
  aliases: [{ barcode: "SOPORTE-ALT", variantId: null }],
}

function target(product: LabelCatalogProduct, variantId: number | null) {
  const found = buildLabelTargets(product).targets.find((item) => item.variantId === variantId)
  assert.ok(found)
  return found
}

function item(product: LabelCatalogProduct, variantId: number | null, copies: number, code?: string): LabelQueueItem {
  const selected = target(product, variantId)
  const created = createQueueItem(selected, code ?? selected.options[0].code, copies)
  assert.ok(created)
  return created
}

// Patrón real de BWIPP para cada código.
const patterns = new Map<string, BarcodePattern>([EAN_A, EAN_B, EAN_C, "BX-SOP-000030", "BX-BOT-000202"].map((code) => [code, encodeBarcodePattern(code)]))

test("barcode: detecta EAN-13/EAN-8/UPC-A sólo con dígito verificador válido; interno y resto en Code 128", () => {
  assert.equal(gtinCheckDigit("779000100001"), 9)
  assert.equal(isValidGtin(EAN_A, 13), true)
  assert.equal(classifyBarcode(EAN_A)?.symbology, "ean13")
  assert.equal(classifyBarcode("96385074")?.symbology, "ean8")
  assert.equal(classifyBarcode("036000291452")?.symbology, "upca")
  const beyonix = classifyBarcode("BX-AUR-000001")
  assert.equal(beyonix?.kind, "beyonix")
  assert.equal(beyonix?.symbology, "code128")
  // Nunca se inventa ni se corrige un EAN: con verificador inválido va en Code 128.
  const invalid = classifyBarcode("7790001000013")
  assert.equal(invalid?.symbology, "code128")
  assert.match(invalid?.notice ?? "", /dígito verificador/)
  assert.equal(classifyBarcode("ENC-MAR-ALT")?.symbology, "code128")
  assert.equal(classifyBarcode("  "), null)
  assert.equal(classifyBarcode("CÓDIGO"), null, "fuera de ASCII no se imprime en Code 128")
})

test("barcode: patrón BWIPP con módulos esperados por simbología", () => {
  const ean = encodeBarcodePattern(EAN_A)
  assert.equal(ean.symbology, "ean13")
  assert.equal(ean.bars.reduce((sum, width) => sum + width, 0), 95)
  assert.equal(ean.bars.length % 2, 1, "empieza y termina con barra")
  assert.equal(encodeBarcodePattern("96385074").bars.reduce((sum, width) => sum + width, 0), 67)
  assert.equal(encodeBarcodePattern("036000291452").bars.reduce((sum, width) => sum + width, 0), 95)
  const code128 = encodeBarcodePattern("BX-AUR-000001")
  assert.equal(code128.symbology, "code128")
  assert.ok(code128.bars.every((width) => width >= 1 && width <= 4))
  assert.throws(() => encodeBarcodePattern(""), /no se puede imprimir/)
})

test("variantes: normal, aleatoria, bicolor, alias y producto sin variantes", () => {
  const normal = buildLabelTargets(lighter)
  assert.equal(normal.targets.length, 2)
  assert.equal(normal.targets[0].variantLabel, "MARRÓN")
  assert.deepEqual(normal.targets[0].options.map((option) => [option.code, option.source]), [[EAN_A, "principal"], ["ENC-MAR-ALT", "alias"], ["ENC-MAR", "sku"]])
  // El alias de grupo no identifica el color: no se ofrece para imprimir.
  assert.deepEqual(normal.groupAliases, ["7790000000000"])
  assert.ok(normal.targets.every((entry) => entry.options.every((option) => option.code !== "7790000000000")))

  const random = buildLabelTargets(bottle)
  assert.equal(random.targets.length, 3, "venta aleatoria: cada variante física por separado")
  assert.ok(random.targets.every((entry) => entry.randomSale))
  assert.equal(random.targets[0].variantLabel, "AZUL / ROSA", "bicolor usa el nombre de la variante")
  assert.equal(random.targets[0].colorHexSecondary, "#F472B6")
  assert.equal(random.targets[1].internalCode, "BX-BOT-000202")
  assert.equal(random.targets[1].options[0].classification.kind, "beyonix")
  assert.equal(random.targets[2].options.length, 0, "sin código ni SKU: nada para imprimir")
  assert.equal(random.targets[2].active, false)
  assert.deepEqual(random.groupAliases, ["GRUPO-BOTELLA"])

  const single = buildLabelTargets(stand)
  assert.equal(single.targets.length, 1)
  assert.equal(single.targets[0].variantId, null)
  assert.deepEqual(single.targets[0].options.map((option) => option.code), ["BX-SOP-000030", "SOPORTE-ALT", "SOP-NB"], "sin variantes, el alias de producto sí identifica el artículo")
  assert.deepEqual(single.groupAliases, [])
})

test("cola: agregar, sumar duplicados, quitar, cantidad válida y orden", () => {
  assert.equal(parseCopies("0"), null)
  assert.equal(parseCopies(-3), null)
  assert.equal(parseCopies(Number.NaN), null)
  assert.equal(parseCopies("2.5"), null)
  assert.equal(parseCopies(2.5), null)
  assert.equal(parseCopies("7"), 7)
  assert.equal(parseCopies(900, 100), 100)

  let queue: LabelQueueItem[] = []
  queue = addToQueue(queue, item(lighter, 101, 3), 100).queue
  const merged = addToQueue(queue, item(lighter, 101, 2), 100)
  assert.equal(merged.merged, true)
  queue = merged.queue
  assert.equal(queue.length, 1)
  assert.equal(queue[0].copies, 5, "Marrón ×3 + ×2 → ×5")
  queue = addToQueue(queue, item(lighter, 102, 3), 100).queue
  queue = addToQueue(queue, item(bottle, 201, 4), 100).queue
  queue = addToQueue(queue, item(stand, null, 2), 100).queue
  assert.equal(queueLabelCount(queue), 14)

  const clamped = addToQueue(queue, item(stand, null, 99), 100)
  assert.equal(clamped.clamped, true)
  assert.equal(clamped.queue.find((entry) => entry.productId === 30)?.copies, 100)

  const key = queue[0].key
  assert.equal(setQueueCopies(queue, key, 0, 100)[0].copies, 5, "0 no se acepta")
  assert.equal(setQueueCopies(queue, key, "abc", 100)[0].copies, 5, "NaN no se acepta")
  assert.equal(setQueueCopies(queue, key, 8, 100)[0].copies, 8)
  assert.equal(stepQueueCopies(queue, key, -10, 100)[0].copies, 1, "el − nunca baja de 1")
  assert.equal(stepQueueCopies(queue, key, 1, 100)[0].copies, 6)
  assert.equal(removeFromQueue(queue, key).length, 3)
  assert.deepEqual(moveQueueItem(queue, key, 1).map((entry) => entry.productId), [10, 10, 20, 30])
  assert.equal(moveQueueItem(queue, key, 1)[1].key, key)
  assert.equal(moveQueueItem(queue, key, -1)[0].key, key, "no se mueve fuera de la lista")
  assert.equal(setQueueLabelName(queue, key, "  Encendedor  ")[0].labelName, " Encendedor ")
  assert.equal(setQueueLabelName(queue, key, "   ")[0].labelName, null)

  // Cambiar a un código equivalente; si ya existe esa fila, se unen.
  const withAlias = changeQueueCode(queue, key, target(lighter, 101), "ENC-MAR-ALT", 100)
  assert.equal(withAlias[0].code, "ENC-MAR-ALT")
  assert.equal(withAlias[0].codeSource, "alias")
  const both = addToQueue(queue, item(lighter, 101, 1, "ENC-MAR-ALT"), 100).queue
  const joined = changeQueueCode(both, key, target(lighter, 101), "ENC-MAR-ALT", 100)
  assert.equal(joined.filter((entry) => entry.variantId === 101).length, 1)
  assert.equal(joined.find((entry) => entry.variantId === 101)?.copies, 6)

  // Orden: manual = cola; agrupar por producto o variante.
  const mixed = [queue[2], queue[0], queue[3], queue[1]]
  assert.deepEqual(orderQueue(mixed, "manual").map((entry) => entry.variantId), [201, 101, null, 102])
  assert.deepEqual(orderQueue(mixed, "product").map((entry) => entry.variantId), [201, 101, 102, null])
  assert.deepEqual(orderQueue(mixed, "variant").map((entry) => entry.variantId), [201, 101, 102, null])
  const expanded = expandQueue(queue, "manual")
  assert.equal(expanded.length, 14)
  assert.deepEqual(expanded.slice(0, 6).map((entry) => entry.variantId), [101, 101, 101, 101, 101, 102])
})

test("cola: almacenamiento no confiable y revalidación contra el catálogo", () => {
  const stored = parseStoredQueue([
    item(lighter, 101, 2),
    { productId: -1, code: "X", copies: 1 },
    { productId: 10, variantId: 101, code: EAN_A, copies: 0 },
    { productId: 10, variantId: "x", code: EAN_A, copies: 1 },
    item(lighter, 101, 4),
    "basura",
  ])
  assert.equal(stored.length, 1, "descarta inválidos y duplicados")
  assert.equal(stored[0].copies, 2)
  assert.deepEqual(parseStoredQueue({}), [])

  const queue = [item(lighter, 101, 2), item(lighter, 102, 1), item(stand, null, 1)]
  const renamed = { ...lighter, name: "Encendedor USB", variants: [{ ...lighter.variants[0] }, { ...lighter.variants[1], barcode: "7790895000980" }] }
  const reconciled = reconcileQueue(queue, [renamed])
  assert.equal(reconciled[0].productName, "Encendedor USB")
  assert.equal(reconciled[0].issue, null)
  assert.match(reconciled[1].issue ?? "", /ya no pertenece/)
  assert.match(reconciled[2].issue ?? "", /ya no existe/)
  assert.equal(queueLabelCount(reconciled), 2, "las filas con problema no se imprimen")
})

test("layout A4: columnas, filas, hojas y espacio libre (40×20, 50×25, 80×20, personalizada)", () => {
  const base = { a4: { orientation: "portrait", marginTopMm: 8, marginSideMm: 6, gapXMm: 2, gapYMm: 2, cutMarks: true } } as const
  const small = computeA4Grid(settings({ ...base, widthMm: 40, heightMm: 20 }))
  // (210 − 12 + 2) / 42 = 4,76 → 4 columnas; (297 − 16 + 2) / 22 = 12,8 → 12 filas.
  assert.deepEqual([small.columns, small.rows, small.perPage], [4, 12, 48])
  const standard = computeA4Grid(settings({ ...base, widthMm: 50, heightMm: 25 }))
  assert.deepEqual([standard.columns, standard.rows], [3, 10])
  const strip = computeA4Grid(settings({ ...base, widthMm: 80, heightMm: 20 }))
  assert.deepEqual([strip.columns, strip.rows], [2, 12])
  const custom = computeA4Grid(settings({ widthMm: 70, heightMm: 37, a4: { orientation: "portrait", marginTopMm: 0, marginSideMm: 0, gapXMm: 0, gapYMm: 0, cutMarks: false } }))
  assert.deepEqual([custom.columns, custom.rows], [3, 8], "hoja autoadhesiva 3×8 de 70×37 mm")
  const landscape = computeA4Grid(settings({ widthMm: 40, heightMm: 20, a4: { ...base.a4, orientation: "landscape" } }))
  assert.equal(landscape.pageWidthMm, 297)
  assert.deepEqual([landscape.columns, landscape.rows], [6, 8])

  // Caso real: 5 + 3 + 4 + 2 = 14 etiquetas de 40×20 → una sola hoja.
  const plan = planLabels(settings({ ...base, widthMm: 40, heightMm: 20 }), 14)
  assert.equal(plan.pages.length, 1)
  assert.equal(plan.grid.perPage, 48)
  assert.equal(plan.freeSlots, 34)
  assert.deepEqual(plan.pages[0].slots.slice(0, 5).map((slot) => [slot.xMm, slot.yMm]), [[6, 8], [48, 8], [90, 8], [132, 8], [6, 30]])
  assert.ok(plan.unusedPercent > 80)
  const two = planLabels(settings({ ...base, widthMm: 40, heightMm: 20 }), 49)
  assert.equal(two.pages.length, 2)
  assert.equal(two.pages[1].slots.length, 1)
  assert.equal(two.pages[1].slots[0].index, 48)

  const impossible = planLabels({ ...settings(), widthMm: 205, a4: { ...base.a4, marginSideMm: 10 } }, 3)
  assert.match(impossible.error ?? "", /no entra/)
  assert.equal(planLabels(settings(), MAX_BATCH_LABELS + 1).overLimit, true)
  assert.equal(layoutNotices(settings({ a4: { ...base.a4, marginTopMm: 2 } }))[0]?.tone, "warning")
})

test("layout térmica: una etiqueta por página, rollo y giro", () => {
  const thermal = settings({ mode: "thermal", widthMm: 40, heightMm: 20, dpi: 203, thermal: { gapMm: 3, rotate: false } })
  const plan = planLabels(thermal, 14)
  assert.equal(plan.pages.length, 14)
  assert.deepEqual([plan.pages[0].widthMm, plan.pages[0].heightMm], [40, 20])
  assert.equal(plan.rollLengthMm, 14 * 20 + 13 * 3)
  const rotated = planLabels(settings({ mode: "thermal", widthMm: 30, heightMm: 60, thermal: { gapMm: 2, rotate: true } }), 1)
  assert.deepEqual([rotated.designWidthMm, rotated.designHeightMm], [60, 30], "girada: se diseña apaisada")
  assert.deepEqual([rotated.pages[0].widthMm, rotated.pages[0].heightMm], [30, 60], "la página es la etiqueta física")
})

test("configuración: límites, valores absurdos y presets", () => {
  const normalized = normalizeLabelSettings({ widthMm: 0, heightMm: -5, paddingMm: "abc", dpi: 999, mode: "laser", content: { price: true }, a4: { gapXMm: 500 } })
  assert.equal(normalized.widthMm, 20)
  assert.equal(normalized.heightMm, 10)
  assert.equal(normalized.paddingMm, DEFAULT_LABEL_SETTINGS.paddingMm)
  assert.equal(normalized.dpi, DEFAULT_LABEL_SETTINGS.dpi)
  assert.equal(normalized.mode, "a4")
  assert.equal(normalized.content.price, true)
  assert.equal(normalized.content.name, true)
  assert.equal(normalized.a4.gapXMm, 20)
  assert.equal(normalizeLabelSettings({ widthMm: "50,25" }).widthMm, 50.3)
  assert.equal(measureError("0", { min: 20, max: 120 }, "Ancho"), "Ancho: entre 20 mm y 120 mm.")
  assert.equal(measureError("", { min: 20, max: 120 }, "Ancho"), "Ancho: ingresá un número.")
  assert.equal(measureError("40", { min: 20, max: 120 }, "Ancho"), null)
  assert.equal(matchSizePreset({ widthMm: 50, heightMm: 25 })?.name, "Estándar")
  assert.equal(matchSizePreset({ widthMm: 51, heightMm: 25 }), null)
})

test("preview: medidas reales, zona silenciosa, módulo en puntos enteros y contenido visible", () => {
  const content = { name: autoShortName(lighter.name), variant: "MARRÓN", sku: "ENC-MAR", code: EAN_A, price: 12999, internalCode: "#10-101" }
  assert.equal(content.name, "ENCENDEDOR USB RECARGABLE", "nombre corto sin aclaraciones")
  const pattern = patterns.get(EAN_A) ?? null
  const small = buildLabelDrawing(content, pattern, settings({ widthMm: 40, heightMm: 20, dpi: 300 }))
  assert.equal(small.widthMm, 40)
  assert.ok(small.barcode)
  const dot = 25.4 / 300
  assert.equal(small.barcode.moduleDots, 3)
  assert.ok(Math.abs(small.barcode.moduleMm - 3 * dot) < 0.001, "módulo = 3 puntos de 300 dpi")
  assert.ok(Math.abs(small.barcode.quietZoneMm.left - 11 * small.barcode.moduleMm) < 0.01, "zona silenciosa EAN-13: 11 módulos")
  assert.ok(small.barcode.box.xMm - small.barcode.quietZoneMm.left >= small.paddingMm - 0.001, "las barras no invaden el margen")
  const right = small.barcode.box.xMm + small.barcode.box.widthMm + small.barcode.quietZoneMm.right
  assert.ok(right <= 40 - small.paddingMm + 0.001)
  // Barras sin deformar: cada barra es un múltiplo entero del módulo.
  for (const bar of small.bars) assert.ok(Math.abs(bar.widthMm / small.barcode.moduleMm - Math.round(bar.widthMm / small.barcode.moduleMm)) < 0.02)
  // Texto: dentro del margen, legible y en el orden esperado.
  assert.deepEqual(small.texts.map((text) => text.role), ["name", "variant", "code"], "por defecto: nombre, variante y número")
  for (const text of small.texts) {
    assert.ok(text.sizeMm >= 1.8, "tamaño mínimo legible")
    assert.ok(text.baselineMm <= 20 - small.paddingMm + 0.01)
  }
  assert.equal(small.texts.at(-1)?.text, EAN_A)
  assert.ok(small.texts[0].baselineMm < small.barcode.box.yMm, "el nombre va arriba de las barras")

  // Ajuste en vivo: 40×20 → 50×25 agranda barras y texto.
  const larger = buildLabelDrawing(content, pattern, settings({ widthMm: 50, heightMm: 25, dpi: 300 }))
  assert.ok(larger.barcode && larger.barcode.box.heightMm > small.barcode.box.heightMm)
  assert.ok(larger.barcode.moduleMm >= small.barcode.moduleMm)

  // Contenido visible configurable.
  const withAll = buildLabelDrawing(content, pattern, settings({ widthMm: 80, heightMm: 30, content: { name: true, variant: true, sku: true, barcodeText: true, price: true, internalCode: true } }))
  assert.deepEqual(withAll.texts.map((text) => text.role), ["name", "variant", "price", "meta", "code"])
  assert.match(withAll.texts.find((text) => text.role === "price")?.text ?? "", /12\.999/)
  assert.equal(withAll.texts.find((text) => text.role === "meta")?.text, "SKU ENC-MAR · #10-101")
  const barsOnly = buildLabelDrawing(content, pattern, settings({ content: { name: false, variant: false, sku: false, barcodeText: false, price: false, internalCode: false } }))
  assert.equal(barsOnly.texts.length, 0)

  // Etiqueta demasiado chica: se advierte, no se bloquea ni se comprime.
  const tiny = buildLabelDrawing(content, pattern, settings({ widthMm: 20, heightMm: 10, dpi: 203 }))
  assert.ok(tiny.warnings.some((warning) => ["small-module", "no-fit", "thin-dots"].includes(warning.code)))
  assert.ok(tiny.bars.length > 0)
  const crowded = buildLabelDrawing(content, pattern, settings({ widthMm: 40, heightMm: 12, content: { name: true, variant: true, sku: true, barcodeText: true, price: true, internalCode: true } }))
  assert.ok(crowded.warnings.some((warning) => warning.code === "omitted-text"))
})

test("texto: nombre largo controlado, Unicode español y caracteres no imprimibles", () => {
  assert.equal(sanitizeLabelText("  Ñandú   ¿Pingüino?  "), "Ñandú ¿Pingüino?")
  assert.equal(sanitizeLabelText("Botella 😀"), "Botella ?")
  const wrapped = wrapText("SOPORTE PARA NOTEBOOK ERGONÓMICO REGULABLE DE ALUMINIO", 3, true, 36, 2)
  assert.equal(wrapped.lines.length, 2)
  assert.equal(wrapped.truncated, true)
  assert.ok(wrapped.lines[1].endsWith("…"))
  assert.equal(autoShortName("Mate | Calabaza"), "MATE")
  assert.equal(autoShortName("Té"), "TÉ")
  assert.deepEqual(barcodeModuleWidth("ean13", 113, 37, 203), { moduleMm: 2 * (25.4 / 203), moduleDots: 2 })
  assert.equal(barcodeModuleWidth("code128", 400, 20, 203).moduleDots, null)
})

test("SVG y documento de impresión: medidas físicas en mm, sólo etiquetas", () => {
  const queue = [item(lighter, 101, 5), item(lighter, 102, 3), item(bottle, 201, 4), item(stand, null, 2)]
  const config = settings({ widthMm: 40, heightMm: 20 })
  const batch = prepareBatch(expandQueue(queue, "manual"), patterns, config)
  assert.equal(batch.plan.pages.length, 1)
  assert.equal(batch.drawings[0], batch.drawings[4], "las copias reutilizan la geometría")
  const svg = labelSvgMarkup(batch.drawings[0])
  assert.match(svg, /width="40mm" height="20mm" viewBox="0 0 40 20"/)
  assert.match(svg, /MARRÓN/)
  const html = buildPrintDocument(batch, config)
  assert.match(html, /@page \{ size: 210mm 297mm; margin: 0; \}/)
  assert.equal(html.match(/class="label/g)?.length, 14)
  assert.doesNotMatch(html, /<button|<nav|admin/i, "sólo etiquetas")
  const rotated = labelSvgMarkup(buildLabelDrawing({ name: "X", variant: null, sku: null, code: EAN_A, price: null, internalCode: null }, patterns.get(EAN_A) ?? null, config, { widthMm: 60, heightMm: 30 }), true)
  assert.match(rotated, /width="30mm" height="60mm"/)
  assert.match(rotated, /translate\(30 0\) rotate\(90\)/)
})

test("PDF: tamaño físico exacto (A4 y térmica) y contenido vectorial", async () => {
  const queue = [item(lighter, 101, 5), item(lighter, 102, 3), item(bottle, 201, 4), item(stand, null, 2)]
  const a4 = settings({ widthMm: 40, heightMm: 20 })
  const pdf = await PDFDocument.load(await buildLabelsPdf(prepareBatch(expandQueue(queue, "manual"), patterns, a4), a4))
  assert.equal(pdf.getPageCount(), 1)
  const { width, height } = pdf.getPage(0).getSize()
  assert.ok(Math.abs(width - 595.28) < 0.01 && Math.abs(height - 841.89) < 0.01, "A4 = 210×297 mm")

  const thermal = settings({ mode: "thermal", widthMm: 50, heightMm: 25, dpi: 203 })
  const bytes = await buildLabelsPdf(prepareBatch(expandQueue(queue, "manual"), patterns, thermal), thermal)
  const roll = await PDFDocument.load(bytes)
  assert.equal(roll.getPageCount(), 14)
  const label = roll.getPage(0).getSize()
  assert.ok(Math.abs(label.width - (50 * 72) / 25.4) < 0.01 && Math.abs(label.height - (25 * 72) / 25.4) < 0.01, "página = 50×25 mm")
  assert.ok(!Buffer.from(bytes).includes("/Image"), "sin imágenes rasterizadas")
  await assert.rejects(buildLabelsPdf(prepareBatch([], patterns, a4), a4), /No hay etiquetas/)
})

test("ZPL: comandos nativos con módulo en puntos y copias agrupadas", () => {
  const queue = [item(lighter, 101, 5), item(stand, null, 2)]
  const thermal = settings({ mode: "thermal", widthMm: 50, heightMm: 25, dpi: 203 })
  const zpl = buildZpl(prepareBatch(expandQueue(queue, "manual"), patterns, thermal), thermal)
  assert.equal(zpl.match(/\^XA/g)?.length, 2)
  assert.match(zpl, /\^PW400\n\^LL200/)
  assert.match(zpl, /\^BEN,\d+,N,N\^FD779000100001\^FS/, "EAN-13: la impresora agrega el verificador")
  assert.match(zpl, /\^PQ5,0,1,N/)
  assert.match(zpl, /\^BCN,\d+,N,N,N,A\^FH_\^FDBX-SOP-000030\^FS/)
  assert.match(zpl, /\^BY2,2,\d+/)
  assert.match(zplUnavailableReason(settings()) ?? "", /Térmica/)
  assert.match(zplUnavailableReason(settings({ mode: "thermal", thermal: { gapMm: 2, rotate: true } })) ?? "", /giradas/)
})

test("historial y presets: validación server-side", () => {
  const queue = [item(lighter, 101, 5), item(bottle, 201, 4), item(stand, null, 2)]
  const items = toBatchItems(queue)
  assert.deepEqual(parseBatchItems(items), items)
  assert.equal(defaultBatchName(queue), "Encendedor USB Recargable (plasma) - Edición 2026 + Botella Smart +1")
  assert.equal(parseBatchItems([]), null)
  assert.equal(parseBatchItems([{ ...items[0], copies: 0 }]), null)
  assert.equal(parseBatchItems([{ ...items[0], copies: "3" }]), null)
  assert.equal(parseBatchItems([{ ...items[0], code: "CÓDIGO" }]), null)
  assert.equal(parseBatchItems([{ ...items[0], copies: 300 }, { ...items[1], copies: 201 }]), null, "más de 500 etiquetas")
  assert.equal(parsePresetPayload({ name: "  ", settings: {} }), null)
  const preset = parsePresetPayload({ name: " Zebra  estándar ", settings: { widthMm: 40, heightMm: 20, dpi: 203, mode: "thermal" } })
  assert.equal(preset?.name, "Zebra estándar")
  assert.equal(preset?.settings.dpi, 203)
  assert.equal(preset?.settings.mode, "thermal")
})
