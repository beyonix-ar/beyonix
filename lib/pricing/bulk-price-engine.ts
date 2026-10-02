/**
 * Núcleo ÚNICO de cambios masivos de precio: lo usan el Editor masivo
 * (cambio manual inmediato), los eventos manuales existentes y los eventos
 * programados ("Cambio programado de precios"). Una sola fórmula y un solo
 * redondeo: un evento a las 03:00 calcula exactamente lo mismo que el Editor
 * masivo si se aplicara a mano en ese momento.
 *
 * Módulo puro (sin I/O): la lectura de productos y la escritura viven en
 * quien lo usa.
 */

export const BULK_PRICE_ACTION_KINDS = [
  "discount_percent",
  "price_decrease_percent",
  "price_increase_percent",
  "price_decrease_amount",
  "price_increase_amount",
  "clear_offer",
] as const

export type BulkPriceActionKind = (typeof BULK_PRICE_ACTION_KINDS)[number]

export const BULK_PRICE_PERCENT_ACTIONS: readonly BulkPriceActionKind[] = [
  "discount_percent",
  "price_decrease_percent",
  "price_increase_percent",
]

export const BULK_PRICE_AMOUNT_ACTIONS: readonly BulkPriceActionKind[] = [
  "price_decrease_amount",
  "price_increase_amount",
]

export const BULK_PRICE_ACTION_LABELS: Record<BulkPriceActionKind, string> = {
  discount_percent: "Descuento especial",
  price_decrease_percent: "Baja de precio",
  price_increase_percent: "Aumento de precio",
  price_decrease_amount: "Baja por monto",
  price_increase_amount: "Aumento por monto",
  clear_offer: "Quitar oferta",
}

export function isBulkPriceActionKind(value: unknown): value is BulkPriceActionKind {
  return typeof value === "string" && (BULK_PRICE_ACTION_KINDS as readonly string[]).includes(value)
}

/** Error de validación (texto para Admin) o `null`. Porcentajes entre 1 y 99: nunca un precio negativo o nulo. */
export function validateBulkPriceAction(kind: unknown, value: unknown): string | null {
  if (!isBulkPriceActionKind(kind)) return "Elegí una acción de precios válida."
  if (BULK_PRICE_AMOUNT_ACTIONS.includes(kind)) {
    const amount = Number(value)
    return Number.isFinite(amount) && amount > 0 && amount <= 99_999_999.99 && Math.abs(Math.round(amount * 100) - amount * 100) < 1e-7
      ? null
      : "El monto debe ser positivo, con hasta dos decimales."
  }
  if (!BULK_PRICE_PERCENT_ACTIONS.includes(kind)) return null
  const percent = Number(value)
  if (!Number.isFinite(percent) || percent < 1 || percent > 99) return "El porcentaje debe estar entre 1 y 99."
  return null
}

/**
 * Redondeo comercial del Editor masivo: el precio más cercano terminado en
 * 900, 000 o 500 dentro del millar (debajo de $500, al peso). Nunca menos
 * de $1.
 */
export function roundBulkPrice(value: number) {
  const price = Math.max(1, value)

  if (price < 500) return Math.round(price)

  const thousand = Math.floor(price / 1000) * 1000
  const candidates = [
    thousand - 100,
    thousand,
    thousand + 500,
    thousand + 900,
    thousand + 1000,
  ].filter((candidate) => candidate >= 500)

  return candidates.reduce((closest, candidate) => {
    const candidateDistance = Math.abs(candidate - price)
    const closestDistance = Math.abs(closest - price)

    return candidateDistance <= closestDistance ? candidate : closest
  })
}

export interface BulkPriceFields {
  precio: number
  precio_anterior: number | null
  descuento: number | null
}

/**
 * Nuevos valores de precio de UN producto para la acción. Devuelve los tres
 * campos completos (lo que se escribe y se guarda en el snapshot):
 * - descuento especial / baja: precio rebajado, el actual queda como
 *   `precio_anterior` para mostrar el % OFF;
 * - aumento: precio aumentado, sin oferta;
 * - quitar oferta: mismo precio, sin precio anterior ni descuento.
 */
export function computeBulkPriceUpdate(
  current: { precio: number | string | null; precio_anterior: number | string | null; descuento: number | string | null },
  kind: BulkPriceActionKind,
  value: number,
): BulkPriceFields {
  const currentPrice = Number(current.precio ?? 0)

  if (kind === "discount_percent" || kind === "price_decrease_percent") {
    return {
      precio: roundBulkPrice(currentPrice * (1 - value / 100)),
      precio_anterior: currentPrice,
      descuento: Math.round(value),
    }
  }
  if (kind === "price_increase_percent") {
    return {
      precio: roundBulkPrice(currentPrice * (1 + value / 100)),
      precio_anterior: null,
      descuento: null,
    }
  }
  if (kind === "price_decrease_amount") {
    const raw = currentPrice - value
    return {
      precio: raw < 1 ? 0 : roundBulkPrice(raw),
      precio_anterior: currentPrice,
      descuento: currentPrice > 0 ? Math.round((value / currentPrice) * 100) : null,
    }
  }
  if (kind === "price_increase_amount") {
    return { precio: roundBulkPrice(currentPrice + value), precio_anterior: null, descuento: null }
  }
  // clear_offer
  return { precio: currentPrice, precio_anterior: null, descuento: null }
}
