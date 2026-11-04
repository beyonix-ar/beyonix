// Documento HTML imprimible de etiquetas (producto, paquete de envío, Bulto general). Sin
// dependencias del navegador para poder testearlo: el SVG Code 128 lo genera el
// servidor (lib/barcodes/render.ts) y llega ya validado.

import type { LocalDeliveryLabel } from "../shipping/local-delivery-label.ts"
import {
  fitLocalDeliveryLabel,
  LOCAL_DELIVERY_LABEL_GEOMETRY as LD,
  LOCAL_DELIVERY_LABEL_TOO_LONG,
  localDeliveryPhoneText,
} from "../shipping/local-delivery-label-layout.ts"

export type LabelFormat = "a4" | "single"

export function dispatchBatchControlUrl(origin: string, batchId: number) {
  return `${origin}/admin/despachos/bultos/${batchId}/control`
}

export function dispatchPdfFilename(code: string) { return `${code}.pdf` }

export type BatchLabelDetails = { displayName: string; orderCodes: readonly string[]; date?: string; url?: string }
export const batchLabelHeight = (count: number) => count ? 43 + 4 * count : 40

export type PrintableLabel =
  | { kind: "product"; code: string; name: string; variant?: string | null; sku?: string | null; copies?: number }
  | { kind: "parcel"; code: string; orderCode: string; index: number; count: number }
  | { kind: "prepared"; code: string; orderCode: string; units: number; parcelCount: number | null }
  | { kind: "batch"; code: string; date?: string | null; details?: BatchLabelDetails }
  /** Etiqueta logística propia Envío BEYONIX (101,6 × 50,8 mm), una por bulto. */
  | LocalDeliveryLabel

const MAX_COPIES = 500

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character)
}

function shortName(value: string, max = 42) {
  const clean = value.trim().replace(/\s+/g, " ")
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export function expandLabels(labels: readonly PrintableLabel[]) {
  return labels.flatMap((label): PrintableLabel[] => {
    if (label.kind !== "product") return [label]
    const copies = Math.min(MAX_COPIES, Math.max(1, Math.floor(label.copies ?? 1)))
    return Array.from({ length: copies }, () => label)
  })
}

function labelBody(label: PrintableLabel, svg: string) {
  const barcode = `<div class="barcode">${svg}</div><div class="code">${escapeHtml(label.code)}</div>`
  if (label.kind === "product") {
    return `<div class="brand">BEYONIX</div>
      <div class="name">${escapeHtml(shortName(label.name))}</div>
      <div class="meta">${escapeHtml([label.variant?.trim(), label.sku?.trim() ? `SKU ${label.sku.trim()}` : ""].filter(Boolean).join(" · "))}</div>
      ${barcode}`
  }
  if (label.kind === "parcel") {
    return `<div class="internal-title">Pedido ${escapeHtml(label.orderCode)}</div>
      <div class="barcode">${svg}</div>`
  }
  if (label.kind === "prepared") {
    return `<div class="internal-title">Pedido ${escapeHtml(label.orderCode)}</div>
      <div class="barcode">${svg}</div>`
  }
  if (label.kind === "local_delivery") return localDeliveryLabelBody(label, svg)
  if (label.details?.url) return `<div class="title">${escapeHtml(label.details.displayName)}</div>
    <div class="batch-count">${label.details.orderCodes.length} ${label.details.orderCodes.length === 1 ? "pedido" : "pedidos"}</div>
    <div class="batch-date">${escapeHtml(label.details.date ?? "")}</div>
    <div class="batch-qr">${svg}</div>`
  if (label.details) return `<div class="title">${escapeHtml(label.details.displayName)}</div>
    <div class="batch-count">${label.details.orderCodes.length} ${label.details.orderCodes.length === 1 ? "pedido" : "pedidos"}</div>
    <div class="batch-orders">${label.details.orderCodes.map(escapeHtml).join(" · ")}</div>
    <div class="barcode">${svg}</div>`
  return `<div class="title">Bulto general</div><div class="code">${escapeHtml(label.code)}</div><div class="barcode">${svg}</div>`
}

// Jerarquía para el cadete: servicio, pedido y bulto X/N arriba; destinatario,
// dirección, referencia, localidad/CP y teléfono COMPLETOS (sin cortes: el
// tamaño se adapta con fitLocalDeliveryLabel); Code 128 con zona de silencio,
// BX-PKG legible y fecha abajo. Sin importes, pago, CUIT ni productos.
function localDeliveryLabelBody(label: LocalDeliveryLabel, svg: string) {
  const layout = fitLocalDeliveryLabel(label)
  if (!layout) throw new Error(LOCAL_DELIVERY_LABEL_TOO_LONG)
  const sizes = `--ld-lh:${layout.lineHeight};--ld-recipient:${layout.recipient}pt;--ld-address:${layout.address}pt;--ld-reference:${layout.reference}pt;--ld-city:${layout.city}pt;--ld-phone:${layout.phone}pt`
  const city = [label.locality, label.province].filter(Boolean).join(", ")
  const field = (name: string, className: string, value: string) =>
    `<span class="ld-label">${name}</span><span class="ld-value ${className}">${value}</span>`
  return `<header class="ld-head"><span class="ld-brand">${escapeHtml(LOCAL_DELIVERY_TITLE)}</span><span class="ld-order">PEDIDO ${escapeHtml(label.orderCode)}</span><span class="ld-parcel">BULTO ${label.index}/${label.count}</span></header>
    <div class="ld-body" style="${sizes}">
      ${field("DESTINATARIO", "ld-recipient", escapeHtml(label.recipient))}
      ${field("DIRECCIÓN", "ld-address", escapeHtml(label.address))}
      ${label.reference ? field("REFERENCIA", "ld-reference", escapeHtml(label.reference)) : ""}
      ${field("LOCALIDAD", "ld-city", `${escapeHtml(city)} · <strong>CP ${escapeHtml(label.postalCode)}</strong>`)}
      ${field("TELÉFONO", "ld-phone", escapeHtml(localDeliveryPhoneText(label.phone)))}
    </div>
    <div class="barcode">${svg.replace("<svg ", '<svg preserveAspectRatio="none" ')}</div>
    <div class="ld-foot"><span class="ld-date">${escapeHtml(label.date)}</span><span class="code">${escapeHtml(label.code)}</span><span></span></div>`
}

const LOCAL_DELIVERY_TITLE = "ENVÍO BEYONIX"

/**
 * Última barrera antes del diálogo de impresión: mide la etiqueta Envío
 * BEYONIX ya maquetada en el navegador y devuelve el error si cualquier zona
 * (cabecera, datos de entrega, pie o la etiqueta entera) quedara cortada.
 */
export function findClippedLocalDeliveryLabel(document: Document): string | null {
  for (const label of document.querySelectorAll<HTMLElement>(".label.local_delivery")) {
    for (const box of [label, ...label.querySelectorAll<HTMLElement>(".ld-head, .ld-body, .ld-foot")]) {
      if (box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1) return LOCAL_DELIVERY_LABEL_TOO_LONG
    }
  }
  return null
}

export function buildLabelsDocument(
  labels: readonly PrintableLabel[],
  svgs: Readonly<Record<string, string>>,
  format: LabelFormat,
) {
  const expanded = expandLabels(labels)
  const missing = expanded.find((label) => !svgs[label.code])
  if (missing) throw new Error(`Falta el código de barras de ${missing.code}.`)
  const product = expanded.every((label) => label.kind === "product")
  const localDelivery = expanded.every((label) => label.kind === "local_delivery")
  const internal = expanded.every((label) => label.kind === "parcel" || label.kind === "prepared" || label.kind === "batch")
  // Producto 64×35 mm; identificación interna y Bulto general 76×40 mm.
  // "single" usa el tamaño físico de cada etiqueta en print preview.
  const batchHeight = expanded.some((label) => label.kind === "batch" && label.details?.url) ? 50.8 : Math.max(40, ...expanded.filter((label) => label.kind === "batch").map((label) => batchLabelHeight(label.details?.orderCodes.length ?? 0)))
  // Envío BEYONIX: 101,6 × 50,8 mm (4" × 2"), el formato grande que ya usa la impresora de Despachos.
  const size = product ? { width: 64, height: 35, singleWidth: 60, singleHeight: 40 }
    : localDelivery ? { width: 101.6, height: 50.8, singleWidth: 101.6, singleHeight: 50.8 }
    : internal ? { width: batchHeight === 50.8 ? 101.6 : 76, height: batchHeight, singleWidth: batchHeight === 50.8 ? 101.6 : 76, singleHeight: batchHeight }
    : { width: 95, height: 90, singleWidth: 100, singleHeight: 100 }
  const page = format === "a4"
    ? `@page { size: A4; margin: 6mm; }
       .sheet { display: grid; grid-template-columns: repeat(auto-fill, ${size.width}mm); grid-auto-rows: ${size.height}mm; gap: 0; justify-content: center; }
       .label { border: 0.2mm dashed #bbb; }`
    : `@page { size: ${size.singleWidth}mm ${size.singleHeight}mm; margin: 0; }
       .sheet { display: block; }
       .label { width: ${size.singleWidth}mm; height: ${size.singleHeight}mm; page-break-after: always; break-after: page; }`
  const items = expanded.map((label) => `<section class="label ${label.kind}">${labelBody(label, svgs[label.code])}</section>`).join("")
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas BEYONIX</title><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; font-family: Arial, Helvetica, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    ${page}
    .label { overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 2mm 3mm; break-inside: avoid; page-break-inside: avoid; }
    .label:last-child { break-after: auto; page-break-after: auto; }
    .brand { font-weight: 900; letter-spacing: 0.18em; font-size: 8pt; }
    .name { font-weight: 700; font-size: 8pt; line-height: 1.15; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { font-size: 7pt; line-height: 1.2; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .title { font-weight: 800; font-size: 13pt; margin-top: 1mm; }
    .big { font-weight: 900; font-size: 18pt; margin: 1.5mm 0; }
    .barcode { width: 100%; margin: 1mm 0 0.5mm; }
    .barcode svg { display: block; width: 100%; height: auto; max-height: 14mm; }
    .parcel .barcode svg, .batch .barcode svg, .prepared .barcode svg { max-height: 26mm; }
    .code { font-family: "Courier New", monospace; font-weight: 700; font-size: 9pt; letter-spacing: 0.06em; }
    .parcel .code, .batch .code, .prepared .code { font-size: 13pt; }
    .internal-title { font-weight: 800; font-size: 12pt; line-height: 1.1; }
    .batch-count { font-weight: 700; font-size: 9pt; margin-top: 1mm; }
    .batch-orders { font-weight: 700; font-size: 8pt; line-height: 4mm; overflow-wrap: anywhere; }
    .batch-date { font-size: 9pt; margin-top: 1mm; }
    .batch-qr { width: 27mm; height: 27mm; margin-top: 1mm; }
    .batch-qr svg { display: block; width: 100%; height: 100%; }
    .batch .barcode { margin-top: auto; }
    .batch .barcode svg { max-height: 16mm; }
    .parcel .barcode, .prepared .barcode { width: 100%; margin: 2mm 0 0; padding-inline: 2mm; }
    .parcel .barcode svg, .prepared .barcode svg { width: 100%; max-height: 22mm; object-fit: contain; }
    /* Envío BEYONIX: alturas fijas que suman 50,8 mm (LOCAL_DELIVERY_LABEL_GEOMETRY); los textos nunca se cortan, se adaptan.
       Datos de entrega en peso 700: en Windows, Arial 800/900 es Arial Black (más ancha que las métricas de la estimación).
       Sin overflow: hidden en las zonas: el acento de Á/Ñ en la primera línea nunca se recorta (la barrera mide scrollHeight/scrollWidth). */
    .local_delivery { align-items: stretch; justify-content: flex-start; text-align: left; padding: ${LD.paddingBlockMm}mm ${LD.paddingInlineMm}mm; gap: ${LD.sectionGapMm}mm; }
    .ld-head { flex: none; height: ${LD.headHeightMm}mm; display: flex; align-items: center; justify-content: space-between; gap: 2mm; border-bottom: 0.3mm solid #000; white-space: nowrap; }
    .ld-brand { font-weight: 900; letter-spacing: 0.08em; font-size: 8pt; }
    .ld-order { font-weight: 900; font-size: 9pt; }
    .ld-parcel { font-weight: 900; font-size: 10.5pt; line-height: 1.05; border: 0.4mm solid #000; padding: 0 1.5mm; }
    .ld-body { flex: none; height: ${LD.bodyHeightMm}mm; display: grid; grid-template-columns: ${LD.fieldLabelWidthMm}mm minmax(0, 1fr); column-gap: ${LD.columnGapMm}mm; row-gap: ${LD.rowGapMm}mm; align-content: start; align-items: baseline; }
    .ld-label { font-size: ${LD.fieldLabelPt}pt; font-weight: 700; line-height: 1.1; white-space: nowrap; }
    .ld-value { min-width: 0; line-height: var(--ld-lh); overflow-wrap: anywhere; }
    .ld-recipient { font-weight: 700; font-size: var(--ld-recipient); }
    .ld-address { font-weight: 700; font-size: var(--ld-address); }
    .ld-reference { font-size: var(--ld-reference); }
    .ld-city { font-size: var(--ld-city); }
    .ld-phone { font-weight: 700; font-size: var(--ld-phone); }
    /* Barras anchas para el lector (estiradas en horizontal, como permite Code 128) y zona de silencio a los costados. */
    .local_delivery .barcode { flex: none; height: ${LD.barcodeHeightMm}mm; margin: 0; padding-inline: ${LD.barcodeQuietZoneMm}mm; }
    .local_delivery .barcode svg { display: block; width: 100%; height: ${LD.barcodeHeightMm}mm; max-height: none; }
    .ld-foot { flex: none; height: ${LD.footHeightMm}mm; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; }
    .ld-date { font-size: 6.5pt; }
    .local_delivery .code { text-align: center; font-size: 8pt; line-height: 1; }
  </style></head><body><main class="sheet">${items}</main></body></html>`
}
