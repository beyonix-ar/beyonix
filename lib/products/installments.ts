export const INSTALLMENT_COUNTS = [2, 3, 6] as const
export type InstallmentCount = (typeof INSTALLMENT_COUNTS)[number]

export interface InstallmentsFinancingConfig {
  /** Costo de checkout con acreditación al instante; aplica a cualquier cobro con tarjeta, con o sin cuotas. */
  baseProcessingPercent: number
  /** IVA sobre las comisiones de Mercado Pago (no vienen incluidas). */
  ivaPercent: number
  /** Costo ADICIONAL que cobra Mercado Pago por ofrecer esa cantidad de cuotas, antes de IVA. */
  surchargePercentByCount: Record<InstallmentCount, number>
}

export interface EligibleInstallmentsProduct {
  cuotas_2_habilitadas?: boolean
  cuotas_3_habilitadas?: boolean
  cuotas_6_habilitadas?: boolean
}

const ROUNDING_EPSILON = 1e-6

/**
 * Aplica IVA sobre un % crudo y redondea hacia arriba al entero como margen
 * de seguridad -- nunca se muestra este número al cliente. Compartido entre
 * `getEffectiveInstallmentPercent` y `getSinglePaymentEffectivePercent`. Este
 * % es el COSTO INTERNO que Mercado Pago le cobra a BEYONIX por ese medio de
 * pago -- insumo del precio financiado (ver `lib/pricing/financed-pricing.ts`)
 * y de la simulación de rentabilidad/precio objetivo en Admin (ver
 * lib/pricing/product-pricing.ts). Nunca se muestra este porcentaje al
 * cliente.
 */
function ceilPercentWithIva(
  rawPercent: number,
  config: InstallmentsFinancingConfig,
): number {
  const withIva = rawPercent * (1 + config.ivaPercent / 100)
  return Math.ceil(withIva - ROUNDING_EPSILON)
}

/**
 * % efectivo (costo interno de Mercado Pago para BEYONIX, con IVA incluido)
 * de financiar en `count` cuotas. Insumo del precio objetivo / simulación de
 * rentabilidad en Admin -- nunca se le suma al precio que ve el cliente.
 */
export function getEffectiveInstallmentPercent(
  count: InstallmentCount,
  config: InstallmentsFinancingConfig,
): number {
  const rawPercent =
    config.baseProcessingPercent + config.surchargePercentByCount[count]
  return ceilPercentWithIva(rawPercent, config)
}

/**
 * Igual que `getEffectiveInstallmentPercent`, pero para pago único (sin
 * cuotas): sólo el costo base de checkout con tarjeta, sin el recargo
 * adicional por financiación en cuotas.
 */
export function getSinglePaymentEffectivePercent(
  config: InstallmentsFinancingConfig,
): number {
  return ceilPercentWithIva(config.baseProcessingPercent, config)
}

export function getEligibleInstallmentCounts(
  product: EligibleInstallmentsProduct,
): InstallmentCount[] {
  const counts: InstallmentCount[] = []
  if (product.cuotas_2_habilitadas) counts.push(2)
  if (product.cuotas_3_habilitadas) counts.push(3)
  if (product.cuotas_6_habilitadas) counts.push(6)
  return counts
}

/**
 * Regla del carrito: una modalidad sólo puede ofrecerse si TODOS los
 * productos distintos del carrito la permiten (intersección, no unión). Un
 * producto sin financiación anula esa modalidad para todo el carrito -- no
 * se financia nunca algo que el producto no admite.
 */
export function getCartInstallmentEligibility(
  products: EligibleInstallmentsProduct[],
): InstallmentCount[] {
  if (products.length === 0) return []

  return INSTALLMENT_COUNTS.filter((count) =>
    products.every((product) => getEligibleInstallmentCounts(product).includes(count)),
  )
}

// Las funciones de precio/etiqueta de cara al cliente (contado,
// transferencia, financiado, "Hasta N cuotas de $X") viven en
// `lib/pricing/financed-pricing.ts` -- ese módulo es la única fuente de
// verdad de precios, reutilizada por producto/carrito/checkout/MP/admin.
// Este archivo sólo resuelve ELEGIBILIDAD y el % interno de costo de MP.
