import { A4_MM, MAX_BATCH_LABELS, type LabelSettings } from "./settings.ts"

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
  /** Térmica: largo de rollo consumido (etiquetas + gaps). */
  rollLengthMm: number | null
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
// por producto. A4 llena fila por fila; térmica, una etiqueta por página.
export function planLabels(settings: LabelSettings, totalLabels: number): LabelPlan {
  const total = Math.max(0, Math.floor(totalLabels))
  const overLimit = total > MAX_BATCH_LABELS
  if (settings.mode === "thermal") {
    const design = thermalDesignSize(settings)
    const pages = Array.from({ length: total }, (_, index): LabelPage => ({
      widthMm: settings.widthMm,
      heightMm: settings.heightMm,
      slots: [{ index, xMm: 0, yMm: 0 }],
    }))
    return {
      mode: "thermal",
      designWidthMm: design.widthMm,
      designHeightMm: design.heightMm,
      grid: { pageWidthMm: settings.widthMm, pageHeightMm: settings.heightMm, columns: 1, rows: 1, perPage: 1 },
      totalLabels: total,
      pages,
      freeSlots: 0,
      unusedPercent: 0,
      rollLengthMm: total ? round1(total * settings.heightMm + Math.max(0, total - 1) * settings.thermal.gapMm) : 0,
      overLimit,
      error: null,
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
  if (settings.mode === "thermal" && settings.dpi === 600) {
    notices.push({ tone: "info", message: "Las impresoras térmicas suelen ser de 203 o 300 dpi. Elegí la densidad real para que las barras caigan en puntos enteros." })
  }
  return notices
}
