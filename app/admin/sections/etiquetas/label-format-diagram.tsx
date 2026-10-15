import { computeA4Grid, slotPosition, thermalRowWidth, thermalSlotX } from "@/lib/labels/layout"
import type { LabelSettings } from "@/lib/labels/settings"
import { cn } from "@/lib/utils"

const ROLL_ROWS = 3

// Esquema a escala del formato: tramo de rollo (3 filas) o la hoja A4 con su
// grilla. Sólo ilustra columnas y proporciones; la vista previa real está en el paso 3.
export function LabelFormatDiagram({ settings, className }: { settings: LabelSettings; className?: string }) {
  if (settings.mode === "thermal") {
    const rowWidth = thermalRowWidth(settings)
    const side = Math.max(2, rowWidth * 0.06)
    const gap = Math.max(settings.thermal.gapMm, settings.heightMm * 0.12)
    const width = rowWidth + side * 2
    const height = ROLL_ROWS * settings.heightMm + (ROLL_ROWS - 1) * gap + side * 2
    return (
      <svg viewBox={`0 0 ${width} ${height}`} className={cn("admin-label-diagram block h-auto", className)} aria-hidden="true">
        <rect width={width} height={height} rx={side} className="admin-label-diagram-liner" />
        {Array.from({ length: ROLL_ROWS }, (_, row) =>
          Array.from({ length: settings.thermal.columns }, (_, column) => (
            <rect
              key={`${row}-${column}`}
              x={side + thermalSlotX(settings, column)}
              y={side + row * (settings.heightMm + gap)}
              width={settings.widthMm}
              height={settings.heightMm}
              rx={Math.min(settings.widthMm, settings.heightMm) * 0.08}
              className="admin-label-diagram-label"
            />
          )),
        )}
      </svg>
    )
  }
  const grid = computeA4Grid(settings)
  return (
    <svg viewBox={`0 0 ${grid.pageWidthMm} ${grid.pageHeightMm}`} className={cn("admin-label-diagram block h-auto", className)} aria-hidden="true">
      <rect width={grid.pageWidthMm} height={grid.pageHeightMm} rx={4} className="admin-label-diagram-page" />
      {Array.from({ length: grid.perPage }, (_, offset) => {
        const position = slotPosition(settings, grid, offset)
        return <rect key={offset} x={position.xMm} y={position.yMm} width={settings.widthMm} height={settings.heightMm} rx={1} className="admin-label-diagram-label" />
      })}
    </svg>
  )
}
