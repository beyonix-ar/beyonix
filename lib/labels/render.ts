import { buildLabelDrawing, autoShortName, type BarcodePattern, type LabelContent, type LabelDrawing } from "./drawing.ts"
import { planLabels, thermalDesignSize, type LabelPlan } from "./layout.ts"
import type { LabelQueueItem } from "./queue.ts"
import type { LabelSettings } from "./settings.ts"

export const LABEL_FONT_FAMILY = "Arial, Helvetica, 'Liberation Sans', sans-serif"

export function labelContentFor(item: LabelQueueItem): LabelContent {
  return {
    name: item.labelName?.trim() ? item.labelName.trim() : autoShortName(item.productName),
    variant: item.variantLabel,
    sku: item.sku,
    code: item.code,
    price: item.price,
    internalCode: item.internalCode,
  }
}

export function drawingForItem(item: LabelQueueItem, patterns: ReadonlyMap<string, BarcodePattern>, settings: LabelSettings) {
  const size = settings.mode === "thermal" ? thermalDesignSize(settings) : { widthMm: settings.widthMm, heightMm: settings.heightMm }
  return buildLabelDrawing(labelContentFor(item), patterns.get(item.code) ?? null, settings, size)
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ?? character)
}

const n = (value: number) => String(Math.round(value * 1000) / 1000)

export function barsPath(drawing: LabelDrawing) {
  return drawing.bars.map((bar) => `M${n(bar.xMm)} ${n(bar.yMm)}h${n(bar.widthMm)}v${n(bar.heightMm)}h${n(-bar.widthMm)}z`).join("")
}

/** Contenido interno (unidades = mm), sin el elemento <svg>. */
export function labelSvgBody(drawing: LabelDrawing) {
  const texts = drawing.texts
    .map((text) => `<text x="${n(text.xMm)}" y="${n(text.baselineMm)}" font-size="${n(text.sizeMm)}" font-weight="${text.bold ? 700 : 400}" text-anchor="middle">${escapeXml(text.text)}</text>`)
    .join("")
  const path = drawing.bars.length ? `<path d="${barsPath(drawing)}" fill="#000" shape-rendering="crispEdges"/>` : ""
  return `<rect width="${n(drawing.widthMm)}" height="${n(drawing.heightMm)}" fill="#fff"/>${path}<g fill="#000" font-family="${LABEL_FONT_FAMILY}">${texts}</g>`
}

/**
 * SVG con medidas físicas (width/height en mm). `rotate` gira el diseño 90°
 * en sentido horario dentro de la página física (rollos térmicos de costado).
 */
export function labelSvgMarkup(drawing: LabelDrawing, rotate = false) {
  const pageWidth = rotate ? drawing.heightMm : drawing.widthMm
  const pageHeight = rotate ? drawing.widthMm : drawing.heightMm
  const body = labelSvgBody(drawing)
  const content = rotate ? `<g transform="translate(${n(pageWidth)} 0) rotate(90)">${body}</g>` : body
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(pageWidth)}mm" height="${n(pageHeight)}mm" viewBox="0 0 ${n(pageWidth)} ${n(pageHeight)}">${content}</svg>`
}

export interface PreparedBatch {
  plan: LabelPlan
  labels: LabelQueueItem[]
  drawings: LabelDrawing[]
}

// Una geometría por fila de la cola (las copias la reutilizan).
export function prepareBatch(labels: readonly LabelQueueItem[], patterns: ReadonlyMap<string, BarcodePattern>, settings: LabelSettings): PreparedBatch {
  const byKey = new Map<string, LabelDrawing>()
  const drawings = labels.map((item) => {
    const cached = byKey.get(item.key)
    if (cached) return cached
    const drawing = drawingForItem(item, patterns, settings)
    byKey.set(item.key, drawing)
    return drawing
  })
  return { plan: planLabels(settings, labels.length), labels: [...labels], drawings }
}

// Documento aislado para el diálogo de impresión del navegador: sólo
// etiquetas, @page con la medida física exacta y escala 1:1.
export function buildPrintDocument(batch: PreparedBatch, settings: LabelSettings) {
  const { plan, drawings } = batch
  if (plan.error) throw new Error(plan.error)
  const rotate = plan.mode === "thermal" && settings.thermal.rotate
  const pages = plan.pages.map((page) => {
    const slots = page.slots.map((slot) => {
      const drawing = drawings[slot.index]
      const cut = plan.mode === "a4" && settings.a4.cutMarks ? " cut" : ""
      return `<div class="label${cut}" style="left:${n(slot.xMm)}mm;top:${n(slot.yMm)}mm">${labelSvgMarkup(drawing, rotate)}</div>`
    }).join("")
    return `<section class="page" style="width:${n(page.widthMm)}mm;height:${n(page.heightMm)}mm">${slots}</section>`
  }).join("")
  const pageSize = `${n(plan.grid.pageWidthMm)}mm ${n(plan.grid.pageHeightMm)}mm`
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas BEYONIX</title><style>
    @page { size: ${pageSize}; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { position: relative; overflow: hidden; break-after: page; page-break-after: always; }
    .page:last-child { break-after: auto; page-break-after: auto; }
    .label { position: absolute; line-height: 0; }
    .label svg { display: block; }
    .label.cut { outline: 0.1mm dashed #b8b8b8; }
    @media screen { body { background: #e5e5e5; } .page { margin: 8mm auto; background: #fff; box-shadow: 0 0 2mm rgba(0,0,0,.25); } }
    @media print { .page { margin: 0; box-shadow: none; } }
  </style></head><body>${pages}</body></html>`
}
