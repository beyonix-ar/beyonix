import { A4_MM, MAX_BATCH_LABELS, MAX_ROLL_WIDTH_MM, THERMAL_PRINT_WIDTH_MM, type LabelSettings } from "./settings.ts"

export interface LabelSlot {
  /** Índice de la etiqueta dentro de la tanda expandida. */
  index: number
  xMm: number
  yMm: number
}

export interface LabelPage {
  widthMm: number
  heightMm: number
  slots: LabelSlot[]
}

export interface SheetGrid {
  pageWidthMm: number
  pageHeightMm: number
  columns: number
  rows: number
  perPage: number
}

export interface LabelPlan {
  mode: LabelSettings["mode"]
  /** Medidas de la etiqueta tal como se diseña (girada en térmica si corresponde). */
  designWidthMm: number
  designHeightMm: number
  grid: SheetGrid
  totalLabels: number
  pages: LabelPage[]
  freeSlots: number
  /** Porcentaje del papel usado que queda sin etiqueta (0–100). */
  unusedPercent: number
  /** Térmica: largo de rollo consumido (filas + gaps). */
  rollLengthMm: number | null
  /** Térmica: filas del rollo que se imprimen (cada fila = una página). */
  rollRows: number | null
  overLimit: boolean
  error: string | null
}

const EPSILON = 1e-6

export function a4PageSize(orientation: LabelSettings["a4"]["orientation"]) {
  return orientation === "landscape" ? { widthMm: A4_MM.height, heightMm: A4_MM.width } : { widthMm: A4_MM.width, heightMm: A4_MM.height }
}

// Cuántas etiquetas entran: n·ancho + (n−1)·separación ≤ espacio útil.
function fit(available: number, size: number, gap: number) {
  if (available + EPSILON < size) return 0
  return Math.floor((available + gap + EPSILON) / (size + gap))
}

export function computeA4Grid(settings: LabelSettings): SheetGrid {
  const page = a4PageSize(settings.a4.orientation)
  const columns = fit(page.widthMm - 2 * settings.a4.marginSideMm, settings.widthMm, settings.a4.gapXMm)
  const rows = fit(page.heightMm - 2 * settings.a4.marginTopMm, settings.heightMm, settings.a4.gapYMm)
  return { pageWidthMm: page.widthMm, pageHeightMm: page.heightMm, columns, rows, perPage: columns * rows }
}

export function thermalDesignSize(settings: LabelSettings) {
  return settings.thermal.rotate
    ? { widthMm: settings.heightMm, heightMm: settings.widthMm }
    : { widthMm: settings.widthMm, heightMm: settings.heightMm }
}

const round1 = (value: number) => Math.round(value * 10) / 10

/** Ancho total de una fila del rollo: bordes + columnas + separaciones. */
export function thermalRowWidth(settings: LabelSettings) {
  const { columns, columnGapMm, sideMarginMm } = settings.thermal
  return round1(2 * sideMarginMm + columns * settings.widthMm + (columns - 1) * columnGapMm)
}

/** Posición (mm) de la columna `column` dentro de una fila del rollo. */
export function thermalSlotX(settings: LabelSettings, column: number) {
  return round1(settings.thermal.sideMarginMm + column * (settings.widthMm + settings.thermal.columnGapMm))
}

// Una "etiqueta" térmica muy apaisada (p. ej. 100 × 20 mm) suele ser en
// realidad un rollo de varias columnas. Sugiere dividirla conservando el ancho
// total del rollo; null si no parece el caso.
export function suggestThermalColumns(settings: LabelSettings) {
  if (settings.mode !== "thermal" || settings.thermal.columns !== 1 || settings.thermal.rotate) return null
  if (settings.widthMm < 70 || settings.widthMm < settings.heightMm * 3.5) return null
  const columns = 2
  const widthMm = round1((settings.widthMm - (columns - 1) * settings.thermal.columnGapMm) / columns)
  return widthMm >= 20 ? { columns, widthMm } : null
}

/** Posición (mm) del casillero `offset` de una hoja A4, fila por fila. */
export function slotPosition(settings: LabelSettings, grid: SheetGrid, offset: number) {
  const column = offset % grid.columns
  const row = Math.floor(offset / grid.columns)
  return {
    xMm: round1(settings.a4.marginSideMm + column * (settings.widthMm + settings.a4.gapXMm)),
    yMm: round1(settings.a4.marginTopMm + row * (settings.heightMm + settings.a4.gapYMm)),
  }
}

// Las etiquetas se acomodan corridas en el orden de la tanda: nunca una hoja
// por producto. A4 llena fila por fila; térmica, una fila del rollo por página
// (1 etiqueta, o 2+ si el rollo trae varias columnas).
export function planLabels(settings: LabelSettings, totalLabels: number): LabelPlan {
  const total = Math.max(0, Math.floor(totalLabels))
  const overLimit = total > MAX_BATCH_LABELS
  if (settings.mode === "thermal") {
    const design = thermalDesignSize(settings)
    const columns = settings.thermal.columns
    const rowWidth = thermalRowWidth(settings)
    const rows = Math.ceil(total / columns)
    const pages = Array.from({ length: rows }, (_, row): LabelPage => {
      const first = row * columns
      return {
        widthMm: rowWidth,
        heightMm: settings.heightMm,
        slots: Array.from({ length: Math.min(columns, total - first) }, (_, column) => ({ index: first + column, xMm: thermalSlotX(settings, column), yMm: 0 })),
      }
    })
    const paperArea = rows * rowWidth * settings.heightMm
    return {
      mode: "thermal",
      designWidthMm: design.widthMm,
      designHeightMm: design.heightMm,
      grid: { pageWidthMm: rowWidth, pageHeightMm: settings.heightMm, columns, rows: 1, perPage: columns },
      totalLabels: total,
      pages,
      freeSlots: rows * columns - total,
      unusedPercent: paperArea ? Math.round((1 - (total * settings.widthMm * settings.heightMm) / paperArea) * 100) : 0,
      rollLengthMm: rows ? round1(rows * settings.heightMm + (rows - 1) * settings.thermal.gapMm) : 0,
      rollRows: rows,
      overLimit,
      error: rowWidth > MAX_ROLL_WIDTH_MM ? `La fila del rollo mide ${String(rowWidth).replace(".", ",")} mm: supera los ${MAX_ROLL_WIDTH_MM} mm. Reducí el ancho o las columnas.` : null,
    }
  }
  const grid = computeA4Grid(settings)
  const base = {
    mode: "a4" as const,
    designWidthMm: settings.widthMm,
    designHeightMm: settings.heightMm,
    grid,
    totalLabels: total,
    rollLengthMm: null,
    rollRows: null,
    overLimit,
  }
  if (!grid.perPage) {
    return { ...base, pages: [], freeSlots: 0, unusedPercent: 0, error: "La etiqueta no entra en la hoja con estos márgenes. Reducí el tamaño o los márgenes." }
  }
  const pageCount = Math.ceil(total / grid.perPage)
  const pages = Array.from({ length: pageCount }, (_, pageIndex): LabelPage => {
    const first = pageIndex * grid.perPage
    const count = Math.min(grid.perPage, total - first)
    return {
      widthMm: grid.pageWidthMm,
      heightMm: grid.pageHeightMm,
      slots: Array.from({ length: count }, (_, offset) => ({ index: first + offset, ...slotPosition(settings, grid, offset) })),
    }
  })
  const paperArea = pageCount * grid.pageWidthMm * grid.pageHeightMm
  return {
    ...base,
    pages,
    freeSlots: pageCount * grid.perPage - total,
    unusedPercent: paperArea ? Math.round((1 - (total * settings.widthMm * settings.heightMm) / paperArea) * 100) : 0,
    error: null,
  }
}

export interface LayoutNotice {
  tone: "warning" | "info"
  message: string
}

// Avisos de la configuración de hoja (no bloquean).
export function layoutNotices(settings: LabelSettings): LayoutNotice[] {
  const notices: LayoutNotice[] = []
  if (settings.mode === "a4" && (settings.a4.marginTopMm < 5 || settings.a4.marginSideMm < 4)) {
    notices.push({ tone: "warning", message: "Muchas impresoras domésticas no imprimen a menos de 4–5 mm del borde: las etiquetas del contorno pueden salir cortadas." })
  }
  if (settings.mode === "thermal" && thermalRowWidth(settings) > THERMAL_PRINT_WIDTH_MM) {
    notices.push({ tone: "warning", message: `La fila del rollo mide ${String(thermalRowWidth(settings)).replace(".", ",")} mm: supera el ancho de impresión habitual de una térmica de 4" (104–108 mm). Revisá el ancho de cada etiqueta y la cantidad por fila.` })
  }
  if (settings.mode === "thermal" && settings.dpi === 600) {
    notices.push({ tone: "info", message: "Las impresoras térmicas suelen ser de 203 o 300 dpi. Elegí la densidad real para que las barras caigan en puntos enteros." })
  }
  return notices
}
