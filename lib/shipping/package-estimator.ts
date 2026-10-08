/**
 * Estimador de embalaje de BEYONIX: convierte unidades de producto (medidas y
 * peso del envase de fábrica) en uno o más BULTOS estimados para cotizar.
 *
 * Nunca suma lados: el peso sí se suma, pero las dimensiones exteriores salen
 * de acomodar las unidades en una caja compacta que contenga su volumen. Es
 * una heurística determinista y conservadora, no un bin packing 3D exacto.
 * Trabaja en enteros (gramos, cm, cm³) para dar siempre el mismo resultado.
 *
 * Márgenes (calibrables con las medidas reales que se cargan al armar; ver
 * order_package_parcels.actual_* y ordenes.shipping_estimate):
 * - PACKING_PADDING_PER_SIDE_CM: burbuja/bolsa alrededor del contenido.
 * - MIXED_PACKING_VOLUME_FACTOR: huecos al acomodar productos de formas
 *   distintas (las unidades idénticas se acomodan en grilla, sin este factor).
 * - Peso de embalaje: bolsa + burbuja + eventual caja, proporcional y con tope.
 */

export const PACKAGE_ESTIMATOR_VERSION = "beyonix-packing-v1"

/** 1 cm por lado = +2 cm en cada dimensión exterior. */
export const PACKING_PADDING_PER_SIDE_CM = 1
/** +15% de volumen al combinar productos distintos (huecos de acomodado). */
export const MIXED_PACKING_VOLUME_FACTOR = 1.15
/** Bolsa ecommerce / precinto. */
export const PACKAGING_BASE_WEIGHT_G = 50
/** Burbuja, relleno o caja: 5% del peso de los productos. */
export const PACKAGING_WEIGHT_RATIO = 0.05
/** Tope del peso de embalaje (una caja corrugada grande ronda 1,5 kg). */
export const PACKAGING_MAX_WEIGHT_G = 1_500

/**
 * Unidades: el Admin carga peso en kg y medidas en cm (con coma o punto); el
 * estimador trabaja en gramos y cm enteros para no acumular errores de float.
 * Ej.: un encendedor de 0,072 kg son 72 g.
 */
export const kilogramsToGrams = (kilograms: number) => Math.round(kilograms * 1000)
export const gramsToKilograms = (grams: number) => grams / 1000

export interface PackageLimits {
  /** Peso máximo por bulto, embalaje incluido. */
  maxWeightKg: number
  /** Lado máximo por bulto. */
  maxSideCm: number
}

export interface PackingUnit {
  lengthCm: number
  widthCm: number
  heightCm: number
  weightKg: number
  quantity: number
}

export interface EstimatedParcel {
  /** Lado mayor. */
  lengthCm: number
  widthCm: number
  /** Lado menor. */
  heightCm: number
  volumeCm3: number
  /** Productos + embalaje estimado. */
  weightKg: number
  productsWeightKg: number
  productsVolumeCm3: number
  units: number
}

export interface PackageEstimate {
  version: typeof PACKAGE_ESTIMATOR_VERSION
  parcels: EstimatedParcel[]
  productsWeightKg: number
  productsVolumeCm3: number
  totalWeightKg: number
  totalVolumeCm3: number
}

export type PackageEstimateErrorCode =
  | "INVALID_UNIT"
  | "EMPTY"
  | "UNIT_TOO_HEAVY"
  | "UNIT_TOO_LARGE"

export class PackageEstimateError extends Error {
  readonly code: PackageEstimateErrorCode

  constructor(code: PackageEstimateErrorCode, message: string) {
    super(message)
    this.name = "PackageEstimateError"
    this.code = code
  }
}

interface NormalizedUnit {
  /** Lados ordenados de mayor a menor, en cm enteros (hacia arriba). */
  dims: [number, number, number]
  weightG: number
  quantity: number
}

const MAX_UNITS = 5_000

function normalizeUnits(units: readonly PackingUnit[]): NormalizedUnit[] {
  const normalized: NormalizedUnit[] = []
  for (const unit of units) {
    const values = [unit.lengthCm, unit.widthCm, unit.heightCm, unit.weightKg]
    if (
      values.some((value) => !Number.isFinite(value) || value <= 0) ||
      !Number.isSafeInteger(unit.quantity) ||
      unit.quantity <= 0
    ) {
      throw new PackageEstimateError(
        "INVALID_UNIT",
        "Hay productos sin peso o medidas válidas para estimar el envío.",
      )
    }
    const dims = [unit.lengthCm, unit.widthCm, unit.heightCm]
      .map((value) => Math.ceil(value - 1e-9))
      .sort((left, right) => right - left) as [number, number, number]
    normalized.push({ dims, weightG: kilogramsToGrams(unit.weightKg), quantity: unit.quantity })
  }
  const total = normalized.reduce((sum, unit) => sum + unit.quantity, 0)
  if (total === 0) throw new PackageEstimateError("EMPTY", "No hay productos para estimar el envío.")
  if (total > MAX_UNITS) {
    throw new PackageEstimateError("INVALID_UNIT", "El carrito supera la cantidad máxima de unidades.")
  }
  return normalized
}

export function packagingWeightGrams(productsWeightG: number) {
  return Math.min(
    PACKAGING_MAX_WEIGHT_G,
    PACKAGING_BASE_WEIGHT_G + Math.round(productsWeightG * PACKAGING_WEIGHT_RATIO),
  )
}

const volumeOf = (dims: readonly number[]) => dims[0] * dims[1] * dims[2]
const surfaceOf = ([a, b, c]: readonly number[]) => 2 * (a * b + a * c + b * c)
const sortDesc = (dims: number[]) => dims.sort((left, right) => right - left) as [number, number, number]

/**
 * Unidades idénticas: grilla Nx × Ny × Nz con la forma más compacta (menor
 * superficie exterior; desempata el lado mayor y luego el volumen). 15 cajas
 * pequeñas nunca terminan en una fila de 15.
 */
export function bestGridArrangement(dims: readonly [number, number, number], quantity: number) {
  let best: { dims: [number, number, number]; counts: [number, number, number] } | null = null
  let bestScore: [number, number, number] | null = null
  for (let nx = 1; nx <= quantity; nx += 1) {
    const maxNy = Math.ceil(quantity / nx)
    for (let ny = 1; ny <= maxNy; ny += 1) {
      const nz = Math.ceil(quantity / (nx * ny))
      const box = sortDesc([nx * dims[0], ny * dims[1], nz * dims[2]])
      const score: [number, number, number] = [surfaceOf(box), box[0], volumeOf(box)]
      if (
        !bestScore ||
        score[0] < bestScore[0] ||
        (score[0] === bestScore[0] && (score[1] < bestScore[1] ||
          (score[1] === bestScore[1] && score[2] < bestScore[2])))
      ) {
        best = { dims: box, counts: [nx, ny, nz] }
        bestScore = score
      }
    }
  }
  return best!
}

/**
 * Productos distintos: parte de la huella del producto más grande (ningún
 * lado puede ser menor que el de cualquier unidad) y crece de forma compacta
 * hasta contener el volumen requerido: primero en altura, luego altura y
 * ancho a la par y, si hace falta, como un cubo. Nunca genera un lado largo
 * artificial.
 */
export function compactBoxForVolume(minDims: readonly [number, number, number], requiredVolume: number): [number, number, number] {
  const [a, b, c] = minDims
  if (a * b * c >= requiredVolume) return [a, b, c]
  const up = (value: number) => Math.ceil(value - 1e-9)
  if (requiredVolume / (a * b) <= b) return sortDesc([a, b, up(requiredVolume / (a * b))])
  const side = Math.sqrt(requiredVolume / a)
  if (side <= a) {
    const grown = Math.max(b, up(side))
    return sortDesc([a, grown, Math.max(c, up(requiredVolume / (a * grown)))])
  }
  const cube = up(Math.cbrt(requiredVolume))
  return [cube, cube, cube]
}

function estimateParcel(units: readonly NormalizedUnit[], limits: PackageLimits): EstimatedParcel {
  const productsWeightG = units.reduce((sum, unit) => sum + unit.weightG * unit.quantity, 0)
  const productsVolume = units.reduce((sum, unit) => sum + volumeOf(unit.dims) * unit.quantity, 0)
  const totalUnits = units.reduce((sum, unit) => sum + unit.quantity, 0)
  const distinctShapes = new Set(units.map((unit) => unit.dims.join("x")))

  let content: [number, number, number]
  if (distinctShapes.size === 1) {
    content = bestGridArrangement(units[0].dims, totalUnits).dims
  } else {
    const minDims: [number, number, number] = [
      Math.max(...units.map((unit) => unit.dims[0])),
      Math.max(...units.map((unit) => unit.dims[1])),
      Math.max(...units.map((unit) => unit.dims[2])),
    ]
    content = compactBoxForVolume(minDims, Math.ceil(productsVolume * MIXED_PACKING_VOLUME_FACTOR))
  }

  const padding = PACKING_PADDING_PER_SIDE_CM * 2
  const box = sortDesc(content.map((side) => side + padding))
  if (box[0] > limits.maxSideCm) {
    throw new PackageEstimateError(
      "UNIT_TOO_LARGE",
      `El paquete estimado mide ${box[0]} cm y supera el máximo de ${limits.maxSideCm} cm por lado.`,
    )
  }
  const weightG = productsWeightG + packagingWeightGrams(productsWeightG)
  return {
    lengthCm: box[0],
    widthCm: box[1],
    heightCm: box[2],
    volumeCm3: volumeOf(box),
    weightKg: gramsToKilograms(weightG),
    productsWeightKg: gramsToKilograms(productsWeightG),
    productsVolumeCm3: productsVolume,
    units: totalUnits,
  }
}

/** Mayor peso de productos que entra en un bulto sin superar el máximo con embalaje. */
function maxProductsWeightGrams(maxWeightG: number) {
  let low = 0
  let high = maxWeightG
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (middle + packagingWeightGrams(middle) <= maxWeightG) low = middle
    else high = middle - 1
  }
  return low
}

/**
 * Bultos estimados para un carrito. Divide sólo por el peso máximo por bulto
 * (los productos más pesados primero, completando cada bulto antes de abrir
 * otro). Una unidad que por sí sola supera el límite no se puede enviar.
 */
export function estimatePackages(units: readonly PackingUnit[], limits: PackageLimits): PackageEstimate {
  const normalized = normalizeUnits(units)
  const maxWeightG = kilogramsToGrams(limits.maxWeightKg)
  const capacityG = maxProductsWeightGrams(maxWeightG)

  for (const unit of normalized) {
    if (unit.weightG > capacityG) {
      throw new PackageEstimateError(
        "UNIT_TOO_HEAVY",
        `Un producto pesa ${gramsToKilograms(unit.weightG)} kg y, embalado, supera el máximo de ${limits.maxWeightKg} kg por bulto.`,
      )
    }
  }

  const ordered = [...normalized].sort(
    (left, right) => right.weightG - left.weightG || volumeOf(right.dims) - volumeOf(left.dims),
  )
  const groups: Array<{ weightG: number; units: NormalizedUnit[] }> = []
  for (const unit of ordered) {
    let remaining = unit.quantity
    for (const group of groups) {
      if (remaining === 0) break
      const fit = Math.min(remaining, Math.floor((capacityG - group.weightG) / unit.weightG))
      if (fit <= 0) continue
      group.units.push({ ...unit, quantity: fit })
      group.weightG += fit * unit.weightG
      remaining -= fit
    }
    while (remaining > 0) {
      const fit = Math.min(remaining, Math.floor(capacityG / unit.weightG))
      groups.push({ weightG: fit * unit.weightG, units: [{ ...unit, quantity: fit }] })
      remaining -= fit
    }
  }

  const parcels = groups.map((group) => estimateParcel(group.units, limits))
  const productsWeightG = normalized.reduce((sum, unit) => sum + unit.weightG * unit.quantity, 0)
  return {
    version: PACKAGE_ESTIMATOR_VERSION,
    parcels,
    productsWeightKg: gramsToKilograms(productsWeightG),
    productsVolumeCm3: parcels.reduce((sum, parcel) => sum + parcel.productsVolumeCm3, 0),
    totalWeightKg: gramsToKilograms(parcels.reduce((sum, parcel) => sum + kilogramsToGrams(parcel.weightKg), 0)),
    totalVolumeCm3: parcels.reduce((sum, parcel) => sum + parcel.volumeCm3, 0),
  }
}
