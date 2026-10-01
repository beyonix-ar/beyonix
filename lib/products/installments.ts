/**
 * Cuotas sin interés que BEYONIX puede absorber: hasta 6. La financiación ya
 * NO es una propiedad del producto: depende del TOTAL que se cobra y de lo
 * que Mercado Pago confirma (Admin → Financiación). Si Mercado Pago ofrece
 * 9/12/18, BEYONIX no las absorbe ni las comunica.
 */
export const INSTALLMENT_COUNTS = [2, 3, 6] as const
/** Máximo comercial de cuotas sin interés que BEYONIX absorbe. */
export const MAX_INTEREST_FREE_INSTALLMENTS = 6
export type InstallmentCount = (typeof INSTALLMENT_COUNTS)[number]

export interface InstallmentsFinancingConfig {
  /** Costo de checkout con acreditación al instante; aplica a cualquier cobro con tarjeta, con o sin cuotas. */
  baseProcessingPercent: number
  /** IVA sobre las comisiones de Mercado Pago (no vienen incluidas). */
  ivaPercent: number
  /** Costo ADICIONAL que cobra Mercado Pago por ofrecer esa cantidad de cuotas, antes de IVA. */
  surchargePercentByCount: Record<InstallmentCount, number>
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

// Las funciones de precio/etiqueta de cara al cliente (contado,
// transferencia, financiado, "Hasta N cuotas de $X") viven en
// `lib/pricing/financed-pricing.ts` -- ese módulo es la única fuente de
// verdad de precios, reutilizada por producto/carrito/checkout/MP/admin.
// Este archivo sólo define las cuotas posibles y el % interno de costo de MP.
