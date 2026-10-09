// Configuración de impresión de etiquetas. Todas las medidas en milímetros.
// `normalizeLabelSettings` es la única puerta de entrada (UI, localStorage y
// API): cualquier valor ajeno vuelve al default o se acota a los límites.

export type LabelOutputMode = "a4" | "thermal"
export type LabelOrientation = "portrait" | "landscape"
export type LabelDpi = 203 | 300 | 600
export type LabelTypography = "compacta" | "normal" | "grande"
export type LabelPrintOrder = "manual" | "product" | "variant"

export interface LabelContentOptions {
  name: boolean
  variant: boolean
  sku: boolean
  barcodeText: boolean
  price: boolean
  internalCode: boolean
}

export interface LabelSettings {
  mode: LabelOutputMode
  widthMm: number
  heightMm: number
  /** Margen interno de cada etiqueta (texto y barras nunca lo invaden). */
  paddingMm: number
  dpi: LabelDpi
  typography: LabelTypography
  order: LabelPrintOrder
  content: LabelContentOptions
  /** Tope de copias por fila de la cola. */
  maxCopiesPerItem: number
  a4: {
    orientation: LabelOrientation
    marginTopMm: number
    marginSideMm: number
    gapXMm: number
    gapYMm: number
    cutMarks: boolean
  }
  thermal: {
    gapMm: number
    /** Gira la etiqueta 90° para rollos que alimentan de costado. */
    rotate: boolean
  }
}

export const MAX_BATCH_LABELS = 500
export const MAX_COPIES_LIMIT = 500

export const A4_MM = { width: 210, height: 297 } as const

export const LABEL_LIMITS = {
  widthMm: { min: 20, max: 120 },
  heightMm: { min: 10, max: 120 },
  paddingMm: { min: 0.5, max: 10 },
  marginTopMm: { min: 0, max: 40 },
  marginSideMm: { min: 0, max: 40 },
  gapXMm: { min: 0, max: 20 },
  gapYMm: { min: 0, max: 20 },
  thermalGapMm: { min: 0, max: 20 },
  maxCopiesPerItem: { min: 1, max: MAX_COPIES_LIMIT },
} as const

export const LABEL_DPI_OPTIONS: readonly LabelDpi[] = [203, 300, 600]

export const DEFAULT_LABEL_CONTENT: LabelContentOptions = {
  name: true,
  variant: true,
  sku: false,
  barcodeText: true,
  price: false,
  internalCode: false,
}

export const DEFAULT_LABEL_SETTINGS: LabelSettings = {
  mode: "a4",
  widthMm: 40,
  heightMm: 20,
  paddingMm: 1.5,
  dpi: 600,
  typography: "normal",
  order: "manual",
  content: DEFAULT_LABEL_CONTENT,
  maxCopiesPerItem: 100,
  a4: { orientation: "portrait", marginTopMm: 8, marginSideMm: 6, gapXMm: 2, gapYMm: 2, cutMarks: true },
  thermal: { gapMm: 3, rotate: false },
}

export interface LabelSizePreset {
  id: string
  name: string
  widthMm: number
  heightMm: number
}

// Tamaños de partida; el usuario siempre puede escribir otro (Personalizada).
export const LABEL_SIZE_PRESETS: readonly LabelSizePreset[] = [
  { id: "small", name: "Pequeña", widthMm: 40, heightMm: 20 },
  { id: "standard", name: "Estándar", widthMm: 50, heightMm: 25 },
  { id: "strip", name: "Tira", widthMm: 80, heightMm: 20 },
  { id: "large", name: "Grande", widthMm: 80, heightMm: 30 },
]

export function matchSizePreset(settings: Pick<LabelSettings, "widthMm" | "heightMm">) {
  return LABEL_SIZE_PRESETS.find((preset) => preset.widthMm === settings.widthMm && preset.heightMm === settings.heightMm) ?? null
}

type Limit = { min: number; max: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Redondea a 0,1 mm y acota; NaN/no numérico → fallback. */
export function clampMm(value: unknown, limit: Limit, fallback: number) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replace(",", ".")) : Number.NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(limit.max, Math.max(limit.min, Math.round(number * 10) / 10))
}

function pick<T extends string | number>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

export function normalizeLabelSettings(input: unknown): LabelSettings {
  const source = isRecord(input) ? input : {}
  const defaults = DEFAULT_LABEL_SETTINGS
  const content = isRecord(source.content) ? source.content : {}
  const a4 = isRecord(source.a4) ? source.a4 : {}
  const thermal = isRecord(source.thermal) ? source.thermal : {}
  const maxCopies = clampMm(source.maxCopiesPerItem, LABEL_LIMITS.maxCopiesPerItem, defaults.maxCopiesPerItem)
  return {
    mode: pick(source.mode, ["a4", "thermal"] as const, defaults.mode),
    widthMm: clampMm(source.widthMm, LABEL_LIMITS.widthMm, defaults.widthMm),
    heightMm: clampMm(source.heightMm, LABEL_LIMITS.heightMm, defaults.heightMm),
    paddingMm: clampMm(source.paddingMm, LABEL_LIMITS.paddingMm, defaults.paddingMm),
    dpi: pick(source.dpi, LABEL_DPI_OPTIONS, defaults.dpi),
    typography: pick(source.typography, ["compacta", "normal", "grande"] as const, defaults.typography),
    order: pick(source.order, ["manual", "product", "variant"] as const, defaults.order),
    content: {
      name: bool(content.name, defaults.content.name),
      variant: bool(content.variant, defaults.content.variant),
      sku: bool(content.sku, defaults.content.sku),
      barcodeText: bool(content.barcodeText, defaults.content.barcodeText),
      price: bool(content.price, defaults.content.price),
      internalCode: bool(content.internalCode, defaults.content.internalCode),
    },
    maxCopiesPerItem: Math.round(maxCopies),
    a4: {
      orientation: pick(a4.orientation, ["portrait", "landscape"] as const, defaults.a4.orientation),
      marginTopMm: clampMm(a4.marginTopMm, LABEL_LIMITS.marginTopMm, defaults.a4.marginTopMm),
      marginSideMm: clampMm(a4.marginSideMm, LABEL_LIMITS.marginSideMm, defaults.a4.marginSideMm),
      gapXMm: clampMm(a4.gapXMm, LABEL_LIMITS.gapXMm, defaults.a4.gapXMm),
      gapYMm: clampMm(a4.gapYMm, LABEL_LIMITS.gapYMm, defaults.a4.gapYMm),
      cutMarks: bool(a4.cutMarks, defaults.a4.cutMarks),
    },
    thermal: {
      gapMm: clampMm(thermal.gapMm, LABEL_LIMITS.thermalGapMm, defaults.thermal.gapMm),
      rotate: bool(thermal.rotate, defaults.thermal.rotate),
    },
  }
}

/** Valida un número escrito por el usuario; null = válido. */
export function measureError(value: string, limit: Limit, label: string) {
  const number = Number(value.trim().replace(",", "."))
  if (!value.trim() || !Number.isFinite(number)) return `${label}: ingresá un número.`
  if (number < limit.min || number > limit.max) {
    return `${label}: entre ${formatMm(limit.min)} y ${formatMm(limit.max)}.`
  }
  return null
}

export function formatMm(value: number) {
  return `${Number.isInteger(value) ? value : value.toFixed(1).replace(".", ",")} mm`
}
