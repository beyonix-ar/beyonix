import type { PreparedBatch } from "./render.ts"
import type { LabelSettings } from "./settings.ts"

// Exportación ZPL II (Zebra y Honeywell con emulación ZPL). Usa las mismas
// medidas que el PDF: posiciones y ancho de módulo en puntos de la impresora.
// El código lo dibuja la impresora con sus comandos nativos (^BC/^BE/^B8/^BU).
// Un formato ^XA…^XZ = una fila del rollo (1 etiqueta o varias columnas); las
// filas idénticas consecutivas se agrupan con ^PQ.
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
  const rows = batch.plan.pages.map((page) => {
    const fields: string[] = []
    for (const slot of page.slots) {
      const drawing = batch.drawings[slot.index]
      const code = batch.labels[slot.index].code
      const innerX = dots(slot.xMm + drawing.paddingMm)
      const innerWidth = dots(drawing.widthMm - 2 * drawing.paddingMm)
      for (const text of drawing.texts) {
        const height = Math.max(10, dots(text.sizeMm))
        fields.push(`^FO${innerX},${dots(text.baselineMm - text.sizeMm * 0.76)}^A0N,${height},${height}^FB${innerWidth},1,0,C^FH_^FD${escapeField(text.text)}^FS`)
      }
      const barcode = drawing.barcode
      if (barcode?.moduleDots) {
        const height = dots(barcode.box.heightMm)
        const origin = `^FO${dots(slot.xMm + barcode.box.xMm)},${dots(barcode.box.yMm)}`
        const command = barcode.symbology === "ean13"
          ? `^BEN,${height},N,N^FD${code.slice(0, 12)}^FS`
          : barcode.symbology === "ean8"
            ? `^B8N,${height},N,N^FD${code.slice(0, 7)}^FS`
            : barcode.symbology === "upca"
              ? `^BUN,${height},N,N,N^FD${code.slice(0, 11)}^FS`
              : `^BCN,${height},N,N,N,A^FH_^FD${escapeField(code)}^FS`
        fields.push(`^BY${barcode.moduleDots},2,${height}`, `${origin}${command}`)
      }
    }
    return { header: ["^XA", "^CI28", `^PW${dots(page.widthMm)}`, `^LL${dots(page.heightMm)}`, "^LH0,0"], fields: fields.join("\n") }
  })
  const blocks: string[] = []
  for (let index = 0; index < rows.length; ) {
    const row = rows[index]
    let copies = 1
    while (index + copies < rows.length && rows[index + copies].fields === row.fields) copies += 1
    blocks.push([...row.header, ...(row.fields ? [row.fields] : []), `^PQ${copies},0,1,N`, "^XZ"].join("\n"))
    index += copies
  }
  return `${blocks.join("\n")}\n`
}
