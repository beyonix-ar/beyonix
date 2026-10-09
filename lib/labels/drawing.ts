import { StandardFontEmbedder, StandardFonts } from "pdf-lib"

import type { LabelSettings } from "./settings.ts"
import { MIN_MODULE_MM, QUIET_ZONE_MODULES, SYMBOLOGY_LABELS, type LabelSymbology } from "./symbology.ts"

// Geometría de una etiqueta en milímetros, compartida por la vista previa
// (SVG), la impresión del navegador (SVG), el PDF (vectorial) y el ZPL. Todo
// sale de acá, así lo que se ve es lo que se imprime.

/** Patrón de barras: anchos alternados barra/espacio en módulos, empieza con barra. */
export interface BarcodePattern {
  symbology: LabelSymbology
  bars: number[]
}

export interface LabelContent {
  name: string
  variant: string | null
  sku: string | null
  code: string
  price: number | null
  internalCode: string | null
}

export interface LabelRect { xMm: number; yMm: number; widthMm: number; heightMm: number }

export interface LabelText {
  text: string
  /** Centro horizontal. */
  xMm: number
  /** Línea de base. */
  baselineMm: number
  sizeMm: number
  bold: boolean
  role: "name" | "variant" | "meta" | "price" | "code"
}

export type LabelWarningCode = "small-module" | "thin-dots" | "no-fit" | "short-bars" | "omitted-text"

export interface LabelWarning { code: LabelWarningCode; message: string }

export interface LabelBarcodeGeometry {
  symbology: LabelSymbology
  /** Rectángulo de las barras (sin zona silenciosa). */
  box: LabelRect
  moduleMm: number
  /** Puntos de impresora por módulo; null si no entra ni con 1 punto. */
  moduleDots: number | null
  quietZoneMm: { left: number; right: number }
  modules: number
}

export interface LabelDrawing {
  widthMm: number
  heightMm: number
  paddingMm: number
  bars: LabelRect[]
  texts: LabelText[]
  barcode: LabelBarcodeGeometry | null
  /** Zona reservada al código cuando todavía no se tiene el patrón. */
  barcodeSlot: LabelRect
  warnings: LabelWarning[]
}

export const MIN_FONT_MM = 1.8 // ≈ 5,1 pt
const MIN_BAR_HEIGHT_MM = 4
const MAX_BAR_HEIGHT_MM = 30
const MAX_MODULE_MM: Record<LabelSymbology, number> = { ean13: 0.495, ean8: 0.495, upca: 0.495, code128: 0.5 }
const LINE_HEIGHT = 1.16
const ASCENT = 0.76
const TEXT_GAP_MM = 0.5
const CODE_TEXT_GAP_MM = 0.35
const TYPOGRAPHY_SCALE: Record<LabelSettings["typography"], number> = { compacta: 0.86, normal: 1, grande: 1.16 }

// pdf-lib tipa `for` con el enum interno de @pdf-lib/standard-fonts; ambos
// enums tienen los mismos valores ("Helvetica", "Helvetica-Bold").
type EmbedderFont = Parameters<typeof StandardFontEmbedder.for>[0]
const regular = StandardFontEmbedder.for(StandardFonts.Helvetica as string as EmbedderFont)
const bold = StandardFontEmbedder.for(StandardFonts.HelveticaBold as string as EmbedderFont)

// Helvetica estándar (PDF) = métricas de Arial (pantalla/impresión). Sólo
// caracteres WinAnsi: tildes, ñ, ü, ¿ y ¡ se conservan; lo demás se reemplaza.
export function sanitizeLabelText(value: string) {
  return [...value.normalize("NFC").replace(/\s+/g, " ").trim()]
    .map((char) => (regular.encoding.canEncodeUnicodeCodePoint(char.codePointAt(0) ?? 0) ? char : "?"))
    .join("")
}

export function textWidthMm(text: string, sizeMm: number, isBold: boolean) {
  return (isBold ? bold : regular).widthOfTextAtSize(text, sizeMm)
}

function ellipsize(text: string, sizeMm: number, isBold: boolean, maxWidth: number) {
  if (textWidthMm(text, sizeMm, isBold) <= maxWidth) return text
  let end = text.length
  while (end > 0 && textWidthMm(`${text.slice(0, end).trimEnd()}…`, sizeMm, isBold) > maxWidth) end -= 1
  return end > 0 ? `${text.slice(0, end).trimEnd()}…` : ""
}

/** Corta en palabras hasta `maxLines`; la última línea se recorta con "…". */
export function wrapText(text: string, sizeMm: number, isBold: boolean, maxWidth: number, maxLines: number) {
  const words = text.split(" ").filter(Boolean)
  const lines: string[] = []
  let current = ""
  for (let index = 0; index < words.length; index += 1) {
    const candidate = current ? `${current} ${words[index]}` : words[index]
    if (textWidthMm(candidate, sizeMm, isBold) <= maxWidth) { current = candidate; continue }
    if (lines.length === maxLines - 1) {
      return { lines: [...lines, ellipsize([candidate, ...words.slice(index + 1)].join(" "), sizeMm, isBold, maxWidth)], truncated: true }
    }
    if (current) lines.push(current)
    current = words[index]
    if (textWidthMm(current, sizeMm, isBold) > maxWidth) {
      if (lines.length === maxLines - 1) return { lines: [...lines, ellipsize([current, ...words.slice(index + 1)].join(" "), sizeMm, isBold, maxWidth)], truncated: true }
      lines.push(ellipsize(current, sizeMm, isBold, maxWidth))
      current = ""
    }
  }
  if (current) lines.push(current)
  return { lines, truncated: false }
}

// Nombre corto automático: sin aclaraciones entre paréntesis ni lo que sigue a
// un separador (" - ", " | ", " – "). El nombre comercial no se modifica.
export function autoShortName(name: string) {
  const clean = name.replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, " ").replace(/\s+/g, " ").trim()
  const head = clean.split(/\s+[-|–—]\s+/)[0]?.trim() ?? clean
  return (head.length >= 3 ? head : clean || name.trim()).toLocaleUpperCase("es")
}

const priceFormatter = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 })

export function formatLabelPrice(price: number) {
  return priceFormatter.format(price)
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round3 = (value: number) => Math.round(value * 1000) / 1000

interface TextBlock {
  role: LabelText["role"]
  text: string
  bold: boolean
  baseSize: number
  maxLines: number
  /** Menor = se conserva más. */
  priority: number
  label: string
}

function measureBlock(block: TextBlock, sizeMm: number, maxWidth: number) {
  const { lines } = wrapText(block.text, sizeMm, block.bold, maxWidth, block.maxLines)
  return { lines, height: lines.length * sizeMm * LINE_HEIGHT }
}

export function barcodeModuleWidth(symbology: LabelSymbology, modules: number, availableMm: number, dpi: number) {
  const dot = 25.4 / dpi
  const target = Math.min(availableMm / modules, MAX_MODULE_MM[symbology])
  const dots = Math.floor(target / dot + 1e-9)
  return dots >= 1 ? { moduleMm: dots * dot, moduleDots: dots } : { moduleMm: target, moduleDots: null }
}

export function buildLabelDrawing(
  content: LabelContent,
  pattern: BarcodePattern | null,
  settings: LabelSettings,
  size: { widthMm: number; heightMm: number } = { widthMm: settings.widthMm, heightMm: settings.heightMm },
): LabelDrawing {
  const { widthMm, heightMm } = size
  const padding = Math.min(settings.paddingMm, widthMm / 4, heightMm / 4)
  const innerWidth = widthMm - 2 * padding
  const innerHeight = heightMm - 2 * padding
  const scale = TYPOGRAPHY_SCALE[settings.typography]
  const warnings: LabelWarning[] = []
  const show = settings.content

  const metaParts = [
    show.sku && content.sku ? `SKU ${content.sku}` : null,
    show.internalCode && content.internalCode && content.internalCode !== content.code ? content.internalCode : null,
  ].filter((part): part is string => Boolean(part))
  const candidates: (TextBlock | null)[] = [
    show.name && content.name.trim() ? { role: "name", text: sanitizeLabelText(content.name), bold: true, baseSize: clamp(innerHeight * 0.14 * scale, MIN_FONT_MM, 4.4), maxLines: innerHeight >= 26 ? 2 : 1, priority: 1, label: "nombre" } : null,
    show.variant && content.variant?.trim() ? { role: "variant", text: sanitizeLabelText(content.variant), bold: false, baseSize: clamp(innerHeight * 0.12 * scale, MIN_FONT_MM, 3.4), maxLines: 1, priority: 2, label: "variante" } : null,
    show.price && content.price != null ? { role: "price", text: sanitizeLabelText(formatLabelPrice(content.price)), bold: true, baseSize: clamp(innerHeight * 0.15 * scale, MIN_FONT_MM, 5), maxLines: 1, priority: 3, label: "precio" } : null,
    metaParts.length ? { role: "meta", text: sanitizeLabelText(metaParts.join(" · ")), bold: false, baseSize: clamp(innerHeight * 0.11 * scale, MIN_FONT_MM, 3), maxLines: 1, priority: 4, label: "SKU / código interno" } : null,
  ]
  let blocks = candidates.filter((block): block is TextBlock => block !== null)
  const codeText = show.barcodeText ? sanitizeLabelText(content.code) : null
  const codeBase = clamp(innerHeight * 0.12 * scale, MIN_FONT_MM, 3.6)

  // Ancho del código: define el tope de altura de barras y los avisos.
  const quiet = pattern ? QUIET_ZONE_MODULES[pattern.symbology] : { left: 0, right: 0 }
  const symbolModules = pattern ? pattern.bars.reduce((sum, width) => sum + width, 0) : 0
  const moduleSize = pattern ? barcodeModuleWidth(pattern.symbology, symbolModules + quiet.left + quiet.right, innerWidth, settings.dpi) : null
  const symbolWidth = moduleSize ? symbolModules * moduleSize.moduleMm : innerWidth
  const maxBarHeight = Math.max(MIN_BAR_HEIGHT_MM, Math.min(MAX_BAR_HEIGHT_MM, symbolWidth * 0.55))

  // Ajuste vertical: primero todo al tamaño base; si las barras quedan por
  // debajo del mínimo se achica el texto al mínimo legible y, como último
  // recurso, se omiten líneas de menor prioridad (avisando).
  let shrink = false
  const omitted: string[] = []
  let layout: { blocks: { block: TextBlock; size: number; lines: string[]; height: number }[]; codeSize: number; codeHeight: number; barHeight: number }
  for (;;) {
    const sized = blocks.map((block) => {
      const size = shrink ? MIN_FONT_MM : block.baseSize
      // El nombre se achica hasta un 20 % antes de recortarse con "…".
      let fitted = measureBlock(block, size, innerWidth)
      if (block.role === "name" && !shrink) {
        for (let candidate = size; candidate >= Math.max(MIN_FONT_MM, size * 0.8) - 1e-9; candidate -= 0.1) {
          const attempt = wrapText(block.text, candidate, true, innerWidth, block.maxLines)
          if (!attempt.truncated) { fitted = { lines: attempt.lines, height: attempt.lines.length * candidate * LINE_HEIGHT }; return { block, size: candidate, ...fitted } }
        }
      }
      return { block, size, ...fitted }
    })
    let codeSize = shrink ? MIN_FONT_MM : codeBase
    while (codeText && codeSize > MIN_FONT_MM && textWidthMm(codeText, codeSize, false) > innerWidth) codeSize = Math.max(MIN_FONT_MM, codeSize - 0.1)
    const codeHeight = codeText ? codeSize * LINE_HEIGHT + CODE_TEXT_GAP_MM : 0
    const textHeight = sized.reduce((sum, item) => sum + item.height, 0) + (sized.length ? TEXT_GAP_MM : 0)
    const remaining = innerHeight - textHeight - codeHeight
    if (remaining >= MIN_BAR_HEIGHT_MM || (shrink && !blocks.length)) {
      layout = { blocks: sized, codeSize, codeHeight, barHeight: Math.max(0, Math.min(remaining, maxBarHeight)) }
      break
    }
    if (!shrink) { shrink = true; continue }
    const drop = blocks.reduce((worst, block) => (block.priority > worst.priority ? block : worst))
    omitted.push(drop.label)
    blocks = blocks.filter((block) => block !== drop)
  }
  if (omitted.length) {
    warnings.push({ code: "omitted-text", message: `No entra todo el texto en el alto de la etiqueta: se omite ${omitted.join(", ")}.` })
  }

  const textHeight = layout.blocks.reduce((sum, item) => sum + item.height, 0) + (layout.blocks.length ? TEXT_GAP_MM : 0)
  const contentHeight = textHeight + layout.barHeight + layout.codeHeight
  let cursor = padding + Math.max(0, (innerHeight - contentHeight) / 2)
  const centerX = widthMm / 2
  const texts: LabelText[] = []
  for (const item of layout.blocks) {
    for (const line of item.lines) {
      texts.push({ text: line, xMm: round3(centerX), baselineMm: round3(cursor + item.size * ASCENT + (item.size * (LINE_HEIGHT - 1)) / 2), sizeMm: round3(item.size), bold: item.block.bold, role: item.block.role })
      cursor += item.size * LINE_HEIGHT
    }
  }
  if (layout.blocks.length) cursor += TEXT_GAP_MM
  const barTop = cursor
  const barcodeSlot = { xMm: round3(padding), yMm: round3(barTop), widthMm: round3(innerWidth), heightMm: round3(layout.barHeight) }
  cursor += layout.barHeight
  if (codeText) {
    cursor += CODE_TEXT_GAP_MM
    texts.push({ text: ellipsize(codeText, layout.codeSize, false, innerWidth), xMm: round3(centerX), baselineMm: round3(cursor + layout.codeSize * ASCENT), sizeMm: round3(layout.codeSize), bold: false, role: "code" })
  }

  const bars: LabelRect[] = []
  let barcode: LabelBarcodeGeometry | null = null
  if (pattern && moduleSize) {
    const quietLeft = quiet.left * moduleSize.moduleMm
    const quietRight = quiet.right * moduleSize.moduleMm
    const startX = padding + (innerWidth - (symbolWidth + quietLeft + quietRight)) / 2 + quietLeft
    let x = startX
    pattern.bars.forEach((width, index) => {
      const barWidth = width * moduleSize.moduleMm
      if (index % 2 === 0) bars.push({ xMm: round3(x), yMm: round3(barTop), widthMm: round3(barWidth), heightMm: round3(layout.barHeight) })
      x += barWidth
    })
    barcode = {
      symbology: pattern.symbology,
      box: { xMm: round3(startX), yMm: round3(barTop), widthMm: round3(symbolWidth), heightMm: round3(layout.barHeight) },
      moduleMm: round3(moduleSize.moduleMm),
      moduleDots: moduleSize.moduleDots,
      quietZoneMm: { left: round3(quietLeft), right: round3(quietRight) },
      modules: symbolModules,
    }
    const label = SYMBOLOGY_LABELS[pattern.symbology]
    if (moduleSize.moduleDots == null || symbolWidth + quietLeft + quietRight > innerWidth + 1e-6) {
      warnings.push({ code: "no-fit", message: `El código ${label} no entra en el ancho de la etiqueta a ${settings.dpi} dpi. Usá una etiqueta más ancha o un código más corto.` })
    } else if (moduleSize.moduleMm < MIN_MODULE_MM[pattern.symbology] - 1e-6) {
      warnings.push({ code: "small-module", message: `Este tamaño puede dificultar la lectura del código (barra mínima de ${moduleSize.moduleMm.toFixed(3).replace(".", ",")} mm; recomendado ≥ ${MIN_MODULE_MM[pattern.symbology].toFixed(2).replace(".", ",")} mm).` })
    }
    if (moduleSize.moduleDots != null && moduleSize.moduleDots < 2 && settings.dpi < 600) {
      warnings.push({ code: "thin-dots", message: `A ${settings.dpi} dpi cada barra fina mide 1 punto: puede empastarse. Probá una etiqueta más ancha o mayor densidad.` })
    }
    const recommendedHeight = Math.max(5, symbolWidth * 0.15)
    if (layout.barHeight < recommendedHeight - 1e-6) {
      warnings.push({ code: "short-bars", message: `Las barras quedan bajas (${layout.barHeight.toFixed(1).replace(".", ",")} mm). Recomendado ≥ ${recommendedHeight.toFixed(1).replace(".", ",")} mm: ocultá texto o usá una etiqueta más alta.` })
    }
  }
  return { widthMm, heightMm, paddingMm: padding, bars, texts, barcode, barcodeSlot, warnings }
}

export const MM_TO_PT = 72 / 25.4
