/**
 * Estimador de bultos de BEYONIX para COTIZAR (checkout, y envíos o reclamos
 * sin medidas reales del armado). Convierte unidades de producto en uno o más
 * bultos estimados.
 *
 * Regla: el peso y las medidas cargados en el producto (Admin → Logística) son
 * los de la UNIDAD LISTA PARA DESPACHO, con el margen de embalaje que el
 * operador decidió incluir. Se usan TAL CUAL: este estimador nunca agrega
 * relleno por lado, peso de caja ni porcentajes de embalaje por unidad (antes
 * lo hacía y duplicaba el margen ya cargado a mano).
 *
 * - 1 unidad: el bulto es exactamente la unidad (mismo peso y medidas).
 * - Varias unidades iguales: se acomodan en grilla con la forma más compacta;
 *   peso = suma, medidas = la grilla (nunca suma de lados).
 * - Productos distintos en un mismo bulto: caja compacta que contiene la suma
 *   de volúmenes + MIXED_PACKING_VOLUME_FACTOR (huecos inevitables al combinar
 *   formas distintas; es un factor de COMBINACIÓN, no de embalaje por unidad).
 * - Se divide en varios bultos sólo por el peso máximo por bulto.
 *
 * El armado real del pedido (medidas del bulto final cargadas por el operador)
 * no pasa por acá: crea el envío con esas medidas reales.
 */

export const PACKAGE_ESTIMATOR_VERSION = "beyonix-packing-v2"

/** +15% de volumen al combinar productos distintos (huecos de acomodado). */
export const MIXED_PACKING_VOLUME_FACTOR = 1.15

/**
 * Unidades: el Admin carga peso en kg y medidas en cm (con coma o punto). El
 * peso se suma en gramos enteros para no acumular errores de float.
 * Ej.: un encendedor de 0,072 kg son 72 g.
 */
export const kilogramsToGrams = (kilograms: number) => Math.round(kilograms * 1000)
export const gramsToKilograms = (grams: number) => grams / 1000

export interface PackageLimits {
  /** Peso máximo por bulto. */
  maxWeightKg: number
  /** Lado máximo por bulto. */
  maxSideCm: number
}

/** Unidad lista para despacho: medidas y peso finales, ya con su embalaje. */
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
  /** Peso del bulto: suma de las unidades (sin agregados). */
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
  /** Lados ordenados de mayor a menor, tal como se cargaron (cm). */
  dims: [number, number, number]
  weightG: number
  quantity: number
}

const MAX_UNITS = 5_000

/** Medidas y volúmenes a 2 decimales: evita restos de float (3 × 0,1 = 0,30000000000000004). */
const toHundredths = (value: number) => Math.round(value * 100) / 100

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
      .map(toHundredths)
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

const volumeOf = (dims: readonly number[]) => toHundredths(dims[0] * dims[1] * dims[2])
const surfaceOf = ([a, b, c]: readonly number[]) => 2 * (a * b + a * c + b * c)
const sortDesc = (dims: number[]) => dims.sort((left, right) => right - left) as [number, number, number]

/**
 * Unidades idénticas: grilla Nx × Ny × Nz con la forma más compacta (menor
 * superficie exterior; desempata el lado mayor y luego el volumen). 15 cajas
 * pequeñas nunca terminan en una fila de 15. Con 1 unidad, la propia unidad.
 */
export function bestGridArrangement(dims: readonly [number, number, number], quantity: number) {
  let best: { dims: [number, number, number]; counts: [number, number, number] } | null = null
  let bestScore: [number, number, number] | null = null
  for (let nx = 1; nx <= quantity; nx += 1) {
    const maxNy = Math.ceil(quantity / nx)
    for (let ny = 1; ny <= maxNy; ny += 1) {
      const nz = Math.ceil(quantity / (nx * ny))
      const box = sortDesc([nx * dims[0], ny * dims[1], nz * dims[2]].map(toHundredths))
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
 * artificial. Los lados que crecen se redondean hacia arriba al cm.
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
  const productsVolume = toHundredths(units.reduce((sum, unit) => sum + volumeOf(unit.dims) * unit.quantity, 0))
  const totalUnits = units.reduce((sum, unit) => sum + unit.quantity, 0)
  const distinctShapes = new Set(units.map((unit) => unit.dims.join("x")))

  let box: [number, number, number]
  if (distinctShapes.size === 1) {
    box = bestGridArrangement(units[0].dims, totalUnits).dims
  } else {
    const minDims: [number, number, number] = [
      Math.max(...units.map((unit) => unit.dims[0])),
      Math.max(...units.map((unit) => unit.dims[1])),
      Math.max(...units.map((unit) => unit.dims[2])),
    ]
    box = compactBoxForVolume(minDims, Math.ceil(productsVolume * MIXED_PACKING_VOLUME_FACTOR))
  }

  if (box[0] > limits.maxSideCm) {
    throw new PackageEstimateError(
      "UNIT_TOO_LARGE",
      `El paquete estimado mide ${box[0]} cm y supera el máximo de ${limits.maxSideCm} cm por lado.`,
    )
  }
  return {
    lengthCm: box[0],
    widthCm: box[1],
    heightCm: box[2],
    volumeCm3: volumeOf(box),
    weightKg: gramsToKilograms(productsWeightG),
    productsWeightKg: gramsToKilograms(productsWeightG),
    productsVolumeCm3: productsVolume,
    units: totalUnits,
  }
}

/**
 * Bultos estimados para un carrito. Divide sólo por el peso máximo por bulto
 * (los productos más pesados primero, completando cada bulto antes de abrir
 * otro). Una unidad que por sí sola supera el límite no se puede enviar.
 */
export function estimatePackages(units: readonly PackingUnit[], limits: PackageLimits): PackageEstimate {
  const normalized = normalizeUnits(units)
  const capacityG = kilogramsToGrams(limits.maxWeightKg)

  for (const unit of normalized) {
    if (unit.weightG > capacityG) {
      throw new PackageEstimateError(
        "UNIT_TOO_HEAVY",
        `Un producto pesa ${gramsToKilograms(unit.weightG)} kg y supera el máximo de ${limits.maxWeightKg} kg por bulto.`,
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
    productsVolumeCm3: toHundredths(parcels.reduce((sum, parcel) => sum + parcel.productsVolumeCm3, 0)),
    totalWeightKg: gramsToKilograms(parcels.reduce((sum, parcel) => sum + kilogramsToGrams(parcel.weightKg), 0)),
    totalVolumeCm3: toHundredths(parcels.reduce((sum, parcel) => sum + parcel.volumeCm3, 0)),
  }
}
