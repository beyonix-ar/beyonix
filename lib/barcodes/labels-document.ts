// Documento HTML imprimible de etiquetas (producto, paquete de envío, Bulto general). Sin
// dependencias del navegador para poder testearlo: el SVG Code 128 lo genera el
// servidor (lib/barcodes/render.ts) y llega ya validado.

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

export function buildLabelsDocument(
  labels: readonly PrintableLabel[],
  svgs: Readonly<Record<string, string>>,
  format: LabelFormat,
) {
  const expanded = expandLabels(labels)
  const missing = expanded.find((label) => !svgs[label.code])
  if (missing) throw new Error(`Falta el código de barras de ${missing.code}.`)
  const product = expanded.every((label) => label.kind === "product")
  const internal = expanded.every((label) => label.kind === "parcel" || label.kind === "prepared" || label.kind === "batch")
  // Producto 64×35 mm; identificación interna y Bulto general 76×40 mm.
  // "single" usa el tamaño físico de cada etiqueta en print preview.
  const batchHeight = expanded.some((label) => label.kind === "batch" && label.details?.url) ? 50.8 : Math.max(40, ...expanded.filter((label) => label.kind === "batch").map((label) => batchLabelHeight(label.details?.orderCodes.length ?? 0)))
  const size = product ? { width: 64, height: 35, singleWidth: 60, singleHeight: 40 }
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
  </style></head><body><main class="sheet">${items}</main></body></html>`
}
