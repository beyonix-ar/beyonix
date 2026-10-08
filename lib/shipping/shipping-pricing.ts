/**
 * Aritmética monetaria del envío, compartida por servidor y Admin para que el
 * mismo dato produzca siempre el mismo resultado. Todo en centavos enteros y
 * el porcentaje en puntos básicos (5,5% = 550): sin floats en los cálculos.
 *
 * Orden exacto del cálculo (cada concepto persistido por orden, ver
 * ordenes.shipping_*):
 *   1. tarifa Andreani (cotizada en checkout)
 *   2. + recargo logístico = tarifa × % (exacto, en centavos)
 *   3. = subtotal logístico exacto
 *   4. redondeo de envío al múltiplo de $10 más cercano (sólo al final)
 *      → precio logístico (`shipping_cost_real`); la diferencia queda como
 *      "ajuste por redondeo" (puede ser negativa)
 *   5. − beneficio BEYONIX (bonificación/subsidio, reglas existentes)
 *   6. = cobrado al cliente (`shipping_cost_charged`)
 *
 * El redondeo a $10 es EXCLUSIVO de envíos: precios de productos, cuotas,
 * transferencia, saldo, ARCA y notas de crédito usan sus propias reglas.
 */

export const SHIPPING_MARKUP_MAX_PERCENT = 50

/** Recotización con bultos reales: se advierte desde esta diferencia... */
export const PARCEL_QUOTE_ALERT_PERCENT = 10
/** ...y sólo si además supera este importe (evita alertas por centavos). */
export const PARCEL_QUOTE_ALERT_MIN_AMOUNT = 500

export class ShippingMarkupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ShippingMarkupError"
  }
}

/** Porcentaje (0 a 50, hasta 2 decimales) a puntos básicos enteros. */
export function markupPercentToBasisPoints(percent: unknown): number {
  const value = typeof percent === "string" ? Number(percent.trim().replace(",", ".")) : percent
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > SHIPPING_MARKUP_MAX_PERCENT) {
    throw new ShippingMarkupError(
      `El recargo logístico debe ser un porcentaje entre 0 y ${SHIPPING_MARKUP_MAX_PERCENT}.`,
    )
  }
  const basisPoints = Math.round(value * 100)
  if (Math.abs(value * 100 - basisPoints) > 1e-6) {
    throw new ShippingMarkupError("El recargo logístico admite hasta 2 decimales.")
  }
  return basisPoints
}

export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new ShippingMarkupError("Importe inválido.")
  const cents = Math.round(amount * 100)
  if (!Number.isSafeInteger(cents)) throw new ShippingMarkupError("Importe inválido.")
  return cents
}

export const fromCents = (cents: number) => cents / 100

/** Recargo en centavos, redondeado al centavo (mitad hacia arriba). */
export function markupCents(providerCents: number, basisPoints: number): number {
  if (!Number.isSafeInteger(providerCents) || providerCents < 0 ||
      !Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new ShippingMarkupError("Datos de recargo inválidos.")
  }
  return Math.floor((providerCents * basisPoints + 5_000) / 10_000)
}

/** $10 en centavos: el precio de envío siempre es un entero terminado en 0. */
const SHIPPING_ROUNDING_STEP_CENTS = 1_000

/**
 * Redondeo de envíos: al múltiplo de $10 más cercano, mitad hacia arriba
 * (987 → 990, 553 → 550, 106 → 110, 10.545 → 10.550). Sin centavos.
 */
export function roundShippingCentsToNearestTen(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new ShippingMarkupError("Importe inválido.")
  return Math.floor((cents + SHIPPING_ROUNDING_STEP_CENTS / 2) / SHIPPING_ROUNDING_STEP_CENTS) * SHIPPING_ROUNDING_STEP_CENTS
}

/** Igual que roundShippingCentsToNearestTen, en pesos. */
export function roundShippingToNearestTen(amount: number): number {
  return fromCents(roundShippingCentsToNearestTen(toCents(amount)))
}

export interface ShippingPriceBreakdown {
  /** Tarifa informada por Andreani (con IVA), sin transformar. */
  providerCents: number
  markupBasisPoints: number
  markupCents: number
  /** Ajuste por el redondeo de envío a $10 (puede ser negativo). */
  roundingCents: number
  /** Precio logístico = proveedor + recargo + ajuste. */
  logisticsCents: number
}

export function buildShippingPriceBreakdown(providerAmount: number, basisPoints: number): ShippingPriceBreakdown {
  const providerCents = toCents(providerAmount)
  if (providerCents <= 0) throw new ShippingMarkupError("La tarifa del proveedor debe ser positiva.")
  const markup = markupCents(providerCents, basisPoints)
  // Subtotal exacto (tarifa × (1 + %), en diezmilésimos de centavo) y un
  // único redondeo al final, al múltiplo de $10: el recargo informado se
  // redondea al centavo y el ajuste absorbe la diferencia.
  const exactTimes10k = providerCents * (10_000 + basisPoints)
  if (!Number.isSafeInteger(exactTimes10k)) throw new ShippingMarkupError("Importe inválido.")
  const stepTimes10k = SHIPPING_ROUNDING_STEP_CENTS * 10_000
  const logisticsCents = Math.floor((exactTimes10k + stepTimes10k / 2) / stepTimes10k) * SHIPPING_ROUNDING_STEP_CENTS
  return {
    providerCents,
    markupBasisPoints: basisPoints,
    markupCents: markup,
    roundingCents: logisticsCents - providerCents - markup,
    logisticsCents,
  }
}

/** true si el desglose es internamente consistente (para validar tokens). */
export function isConsistentShippingPriceBreakdown(breakdown: ShippingPriceBreakdown) {
  try {
    const expected = buildShippingPriceBreakdown(fromCents(breakdown.providerCents), breakdown.markupBasisPoints)
    return expected.markupCents === breakdown.markupCents &&
      expected.roundingCents === breakdown.roundingCents &&
      expected.logisticsCents === breakdown.logisticsCents
  } catch {
    return false
  }
}

export interface ParcelQuoteComparison {
  differenceCents: number
  /** Diferencia porcentual con 2 decimales; null si no hay base. */
  differencePercent: number | null
  alert: boolean
}

/** Cotizado en checkout vs. cotizado con bultos reales (ambos tarifa Andreani). */
export function compareParcelQuote(checkoutProviderCents: number, parcelProviderCents: number): ParcelQuoteComparison {
  const differenceCents = parcelProviderCents - checkoutProviderCents
  const differencePercent = checkoutProviderCents > 0
    ? Math.round((differenceCents * 10_000) / checkoutProviderCents) / 100
    : null
  return {
    differenceCents,
    differencePercent,
    alert: differencePercent !== null &&
      Math.abs(differencePercent) >= PARCEL_QUOTE_ALERT_PERCENT &&
      Math.abs(differenceCents) >= PARCEL_QUOTE_ALERT_MIN_AMOUNT * 100,
  }
}

/**
 * Reparte un importe entre bultos según su peso, al centavo exacto (el
 * último bulto absorbe el resto). Se usa para el valor declarado por bulto.
 */
export function splitAmountByWeights(amount: number, weightsKg: readonly number[]): number[] {
  if (!weightsKg.length) throw new ShippingMarkupError("No hay bultos para repartir el importe.")
  const totalCents = toCents(amount)
  const grams = weightsKg.map((weight) => Math.max(1, Math.round(weight * 1000)))
  const totalGrams = grams.reduce((sum, value) => sum + value, 0)
  let assigned = 0
  return grams.map((value, index) => {
    const cents = index === grams.length - 1
      ? totalCents - assigned
      : Math.floor((totalCents * value) / totalGrams)
    assigned += cents
    return fromCents(cents)
  })
}
