import type { LabelDrawing } from "@/lib/labels/drawing"
import { LABEL_FONT_FAMILY, barsPath } from "@/lib/labels/render"

// Etiqueta en unidades mm (mismo dibujo que el PDF y la impresión). Se anida
// dentro de un <svg> cuyo viewBox también está en mm.
export function LabelGraphic({ drawing, xMm = 0, yMm = 0, rotate = false }: {
  drawing: LabelDrawing
  xMm?: number
  yMm?: number
  rotate?: boolean
}) {
  const pageWidth = rotate ? drawing.heightMm : drawing.widthMm
  const pageHeight = rotate ? drawing.widthMm : drawing.heightMm
  const body = (
    <>
      <rect width={drawing.widthMm} height={drawing.heightMm} fill="#fff" />
      {drawing.bars.length > 0 ? (
        <path d={barsPath(drawing)} fill="#000" shapeRendering="crispEdges" />
      ) : (
        <rect
          x={drawing.barcodeSlot.xMm}
          y={drawing.barcodeSlot.yMm}
          width={drawing.barcodeSlot.widthMm}
          height={drawing.barcodeSlot.heightMm}
          fill="#d4d4d8"
        />
      )}
      <g fill="#000" fontFamily={LABEL_FONT_FAMILY}>
        {drawing.texts.map((text, index) => (
          <text key={index} x={text.xMm} y={text.baselineMm} fontSize={text.sizeMm} fontWeight={text.bold ? 700 : 400} textAnchor="middle">
            {text.text}
          </text>
        ))}
      </g>
    </>
  )
  return (
    <svg x={xMm} y={yMm} width={pageWidth} height={pageHeight} viewBox={`0 0 ${pageWidth} ${pageHeight}`} overflow="hidden">
      {rotate ? <g transform={`translate(${pageWidth} 0) rotate(90)`}>{body}</g> : body}
    </svg>
  )
}
