import type { PreparedBatch } from "./render.ts"
import type { LabelSettings } from "./settings.ts"

// Exportación ZPL II (Zebra y Honeywell con emulación ZPL). Usa las mismas
// medidas que el PDF: posiciones y ancho de módulo en puntos de la impresora.
// El código lo dibuja la impresora con sus comandos nativos (^BC/^BE/^B8/^BU).
// No probado todavía con una impresora física.

const escapeField = (value: string) => value.replace(/[_^~]/g, (character) => `_${character.charCodeAt(0).toString(16).toUpperCase()}`)

export function zplUnavailableReason(settings: LabelSettings) {
  if (settings.mode !== "thermal") return "ZPL sólo está disponible en modo Térmica."
  if (settings.thermal.rotate) return "ZPL todavía no admite etiquetas giradas."
  if (settings.dpi === 600) return "Elegí la densidad real de la impresora (203 o 300 dpi)."
  return null
}

export function buildZpl(batch: PreparedBatch, settings: LabelSettings) {
  const reason = zplUnavailableReason(settings)
  if (reason) throw new Error(reason)
  const dotsPerMm = settings.dpi / 25.4
  const dots = (mm: number) => Math.max(0, Math.round(mm * dotsPerMm))
  const blocks: string[] = []
  for (let index = 0; index < batch.labels.length; ) {
    const item = batch.labels[index]
    let copies = 1
    while (index + copies < batch.labels.length && batch.labels[index + copies].key === item.key) copies += 1
    const drawing = batch.drawings[index]
    const lines = ["^XA", "^CI28", `^PW${dots(drawing.widthMm)}`, `^LL${dots(drawing.heightMm)}`, "^LH0,0"]
    const innerX = dots(drawing.paddingMm)
    const innerWidth = dots(drawing.widthMm - 2 * drawing.paddingMm)
    for (const text of drawing.texts) {
      const height = Math.max(10, dots(text.sizeMm))
      lines.push(`^FO${innerX},${dots(text.baselineMm - text.sizeMm * 0.76)}^A0N,${height},${height}^FB${innerWidth},1,0,C^FH_^FD${escapeField(text.text)}^FS`)
    }
    const barcode = drawing.barcode
    if (barcode?.moduleDots) {
      const height = dots(barcode.box.heightMm)
      const origin = `^FO${dots(barcode.box.xMm)},${dots(barcode.box.yMm)}`
      const code = item.code
      const command = barcode.symbology === "ean13"
        ? `^BEN,${height},N,N^FD${code.slice(0, 12)}^FS`
        : barcode.symbology === "ean8"
          ? `^B8N,${height},N,N^FD${code.slice(0, 7)}^FS`
          : barcode.symbology === "upca"
            ? `^BUN,${height},N,N,N^FD${code.slice(0, 11)}^FS`
            : `^BCN,${height},N,N,N,A^FH_^FD${escapeField(code)}^FS`
      lines.push(`^BY${barcode.moduleDots},2,${height}`, `${origin}${command}`)
    }
    lines.push(`^PQ${copies},0,1,N`, "^XZ")
    blocks.push(lines.join("\n"))
    index += copies
  }
  return `${blocks.join("\n")}\n`
}
