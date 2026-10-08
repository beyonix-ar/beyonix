/**
 * Medidas reales de un bulto armado (FINALIZAR ARMADO). Validación única
 * para la UI y el servidor; la base vuelve a exigir los mismos rangos
 * (set_order_package_parcels_measured).
 */
export const PARCEL_MAX_WEIGHT_KG = 1_000
export const PARCEL_MAX_SIDE_CM = 500
export const MAX_PARCELS = 50

export interface ParcelMeasures {
  weightKg: number
  lengthCm: number
  widthCm: number
  heightCm: number
}

export const PARCEL_MEASURE_FIELDS = [
  { key: "weightKg", label: "Peso", unit: "kg", max: PARCEL_MAX_WEIGHT_KG, decimals: 3 },
  { key: "lengthCm", label: "Largo", unit: "cm", max: PARCEL_MAX_SIDE_CM, decimals: 1 },
  { key: "widthCm", label: "Ancho", unit: "cm", max: PARCEL_MAX_SIDE_CM, decimals: 1 },
  { key: "heightCm", label: "Alto", unit: "cm", max: PARCEL_MAX_SIDE_CM, decimals: 1 },
] as const

export class ParcelMeasuresError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ParcelMeasuresError"
  }
}

/** Texto ingresado por el operador ("2,450" o "2.45") a número; null si vacío o inválido. */
export function parseMeasureText(value: string): number | null {
  const normalized = value.trim().replace(",", ".")
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function parseField(value: unknown, field: (typeof PARCEL_MEASURE_FIELDS)[number], index: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > field.max) {
    throw new ParcelMeasuresError(
      `Bulto ${index + 1}: ${field.label.toLowerCase()} debe ser mayor que 0 y hasta ${field.max} ${field.unit}.`,
    )
  }
  const factor = 10 ** field.decimals
  return Math.round(value * factor) / factor
}

export function parseParcelMeasures(value: unknown): ParcelMeasures[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARCELS) {
    throw new ParcelMeasuresError(`Indicá entre 1 y ${MAX_PARCELS} bultos.`)
  }
  return value.map((parcel, index) => {
    if (!parcel || typeof parcel !== "object" || Array.isArray(parcel)) {
      throw new ParcelMeasuresError(`Bulto ${index + 1}: completá peso y medidas.`)
    }
    const source = parcel as Record<string, unknown>
    const [weightKg, lengthCm, widthCm, heightCm] = PARCEL_MEASURE_FIELDS.map((field) =>
      parseField(source[field.key], field, index))
    return { weightKg, lengthCm, widthCm, heightCm }
  })
}
