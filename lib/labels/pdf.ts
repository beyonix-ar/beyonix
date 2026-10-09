import {
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from "pdf-lib"

import { MM_TO_PT } from "./drawing.ts"
import type { PreparedBatch } from "./render.ts"
import type { LabelSettings } from "./settings.ts"

const BLACK = rgb(0, 0, 0)
const CUT_GRAY = rgb(0.72, 0.72, 0.72)
const pt = (mm: number) => mm * MM_TO_PT

// PDF vectorial: barras como rectángulos y texto Helvetica real (nada
// rasterizado). Página = A4 o la etiqueta física en térmica, a escala 1:1.
export async function buildLabelsPdf(batch: PreparedBatch, settings: LabelSettings) {
  const { plan, drawings } = batch
  if (plan.error) throw new Error(plan.error)
  if (!plan.totalLabels) throw new Error("No hay etiquetas para generar.")
  const document = await PDFDocument.create()
  document.setTitle("Etiquetas BEYONIX")
  document.setCreator("BEYONIX")
  document.setProducer("BEYONIX")
  const [regular, bold] = await Promise.all([
    document.embedFont(StandardFonts.Helvetica),
    document.embedFont(StandardFonts.HelveticaBold),
  ])
  const rotate = plan.mode === "thermal" && settings.thermal.rotate
  for (const sheet of plan.pages) {
    const page = document.addPage([pt(sheet.widthMm), pt(sheet.heightMm)])
    for (const slot of sheet.slots) {
      const drawing = drawings[slot.index]
      if (plan.mode === "a4" && settings.a4.cutMarks) {
        page.drawRectangle({
          x: pt(slot.xMm),
          y: pt(sheet.heightMm - slot.yMm - drawing.heightMm),
          width: pt(drawing.widthMm),
          height: pt(drawing.heightMm),
          borderColor: CUT_GRAY,
          borderWidth: pt(0.1),
          borderDashArray: [pt(1), pt(1)],
        })
      }
      // Sistema local de la etiqueta (y hacia arriba, origen abajo a la
      // izquierda). Girada: 90° horario dentro de la página física.
      const transform = rotate
        ? concatTransformationMatrix(0, -1, 1, 0, 0, pt(sheet.heightMm))
        : concatTransformationMatrix(1, 0, 0, 1, pt(slot.xMm), pt(sheet.heightMm - slot.yMm - drawing.heightMm))
      page.pushOperators(pushGraphicsState(), transform)
      for (const bar of drawing.bars) {
        page.drawRectangle({
          x: pt(bar.xMm),
          y: pt(drawing.heightMm - bar.yMm - bar.heightMm),
          width: pt(bar.widthMm),
          height: pt(bar.heightMm),
          color: BLACK,
        })
      }
      for (const text of drawing.texts) {
        const font = text.bold ? bold : regular
        const size = pt(text.sizeMm)
        page.drawText(text.text, {
          x: pt(text.xMm) - font.widthOfTextAtSize(text.text, size) / 2,
          y: pt(drawing.heightMm - text.baselineMm),
          size,
          font,
          color: BLACK,
        })
      }
      page.pushOperators(popGraphicsState())
    }
  }
  return document.save()
}
