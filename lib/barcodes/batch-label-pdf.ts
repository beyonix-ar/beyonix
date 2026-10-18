import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

import { batchLabelHeight, dispatchPdfFilename, type BatchLabelDetails, type LabelFormat } from "./labels-document.ts"

const POINTS_PER_MM = 72 / 25.4
const labelWidth = 76 * POINTS_PER_MM
const black = rgb(0, 0, 0)

export function batchPdfFilename(codes: readonly string[], details?: Readonly<Record<string, BatchLabelDetails>>) {
  if (codes.length === 1) {
    const name = details?.[codes[0]]?.displayName
    return name ? `${name.replace(/\s*-\s*/g, "-").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "")}.pdf` : dispatchPdfFilename(codes[0])
  }
  return `Bultos-generales-${codes[0]}-${codes.length}.pdf`
}

async function barcodePng(svg: string) {
  const viewBox = /\bviewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg)
  const svgWidth = Number(viewBox?.[1])
  const svgHeight = Number(viewBox?.[2])
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error("No se pudo preparar el código de barras para PDF."))
      image.src = url
    })
    const width = svgWidth || image.naturalWidth
    const height = svgHeight || image.naturalHeight
    if (!width || !height) throw new Error("El código de barras no tiene dimensiones válidas.")
    const canvas = document.createElement("canvas")
    canvas.width = 1200
    canvas.height = Math.max(1, Math.round(canvas.width * height / width))
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Este navegador no puede generar el PDF de la etiqueta.")
    context.fillStyle = "#fff"
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL("image/png")
  } finally { URL.revokeObjectURL(url) }
}

/** PDF separado del diálogo de impresión: texto negro y barcode negro sobre blanco. */
export async function buildBatchLabelsPdf(codes: readonly string[], svgs: Readonly<Record<string, string>>, format: LabelFormat, details?: Readonly<Record<string, BatchLabelDetails>>) {
  if (!codes.length) throw new Error("No hay etiquetas para guardar.")
  const pdf = await PDFDocument.create()
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const images = new Map<string, Awaited<ReturnType<typeof pdf.embedPng>>>()
  for (const code of new Set(codes)) {
    const svg = svgs[code]
    if (!svg) throw new Error(`Falta el código de barras de ${code}.`)
    images.set(code, await pdf.embedPng(await barcodePng(svg)))
  }
  const a4 = format === "a4"
  const columns = a4 ? 2 : 1
  const labelHeight = batchLabelHeight(Math.max(0, ...codes.map((code) => details?.[code]?.orderCodes.length ?? 0))) * POINTS_PER_MM
  const rows = a4 ? Math.max(1, Math.floor((841.89 - 12 * POINTS_PER_MM) / labelHeight)) : 1
  const margin = a4 ? 6 * POINTS_PER_MM : 0
  for (let index = 0; index < codes.length; index += 1) {
    const slot = index % (columns * rows)
    if (slot === 0) pdf.addPage(a4 ? [595.28, 841.89] : [labelWidth, labelHeight])
    const page = pdf.getPages().at(-1)!
    const x = margin + (slot % columns) * labelWidth
    const y = page.getHeight() - margin - (Math.floor(slot / columns) + 1) * labelHeight
    page.drawRectangle({ x, y, width: labelWidth, height: labelHeight, color: rgb(1, 1, 1) })
    const code = codes[index]
    const info = details?.[code]
    const title = info?.displayName ?? "Bulto general"
    page.drawText(title, { x: x + (labelWidth - bold.widthOfTextAtSize(title, 11)) / 2, y: y + labelHeight - 10 * POINTS_PER_MM, size: 11, font: bold, color: black })
    if (info) {
      const count = `${info.orderCodes.length} ${info.orderCodes.length === 1 ? "pedido" : "pedidos"}`
      page.drawText(count, { x: x + (labelWidth - bold.widthOfTextAtSize(count, 9)) / 2, y: y + labelHeight - 16 * POINTS_PER_MM, size: 9, font: bold, color: black })
      info.orderCodes.forEach((order, line) => page.drawText(order, { x: x + (labelWidth - bold.widthOfTextAtSize(order, 8)) / 2, y: y + labelHeight - (21 + line * 4) * POINTS_PER_MM, size: 8, font: bold, color: black }))
    } else page.drawText(code, { x: x + (labelWidth - bold.widthOfTextAtSize(code, 12)) / 2, y: y + 23 * POINTS_PER_MM, size: 12, font: bold, color: black })
    const image = images.get(code)!
    const width = 66 * POINTS_PER_MM
    const height = Math.min(16 * POINTS_PER_MM, width * image.height / image.width)
    page.drawImage(image, { x: x + (labelWidth - width) / 2, y: y + 3 * POINTS_PER_MM, width, height })
  }
  return pdf.save()
}
