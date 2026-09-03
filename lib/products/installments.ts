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

interface EligibleInstallmentsProduct {
  cuotas_2_habilitadas?: boolean
  cuotas_3_habilitadas?: boolean
  cuotas_6_habilitadas?: boolean
}

const ROUNDING_EPSILON = 1e-6

/**
 * Aplica IVA sobre un % crudo y redondea hacia arriba al entero como margen
 * de seguridad -- nunca se muestra este número al cliente. Compartido entre
 * `getEffectiveInstallmentPercent` y `getSinglePaymentEffectivePercent`.
 * MODELO DE PRECIO ÚNICO: este % es exclusivamente el COSTO INTERNO que
 * Mercado Pago le cobra a BEYONIX por ese medio de pago -- se usa para
 * simular rentabilidad y calcular el precio objetivo en Admin (ver
 * lib/pricing/product-pricing.ts), NUNCA para recalcular o "engordar" lo
 * que paga el cliente al elegir cuotas (ver getPlainInstallmentAmount).
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

function formatCommercialPrice(value: number) {
  return `$${Math.round(value).toLocaleString("es-AR")}`
}

/**
 * PRECIO PÚBLICO ÚNICO: el total que paga el cliente es siempre `price`, sin
 * importar cuántas cuotas elija -- elegir cuotas nunca recalcula ni "engorda"
 * el total (eso vivía antes en calculateInstallmentPlan/calculateFinancedTotal,
 * eliminados). Esta función es puramente informativa: `price / count`,
 * redondeado al peso más cercano. La suma de las cuotas puede no coincidir
 * centavo a centavo con `price` si no divide exacto -- es esperado, nunca se
 * "corrige" ajustando el total real.
 */
export function getPlainInstallmentAmount(
  price: number,
  count: InstallmentCount,
): number | null {
  if (!Number.isFinite(price) || price <= 0) return null
  return Math.round(price / count)
}

interface InstallmentDisplayPlan {
  count: InstallmentCount
  installmentAmount: number
}

/**
 * "Hasta N" y no "N" a secas: Checkout Pro configura `installments` como
 * TOPE ofrecido, no como cantidad obligatoria -- según el medio de pago,
 * Mercado Pago puede terminar ofreciéndole al comprador menos cuotas que N
 * (hasta 1 pago) por el mismo monto. Sin "sin interés": bajo el modelo
 * viejo esa palabra describía un gross-up disfrazado; ahora que el total es
 * literalmente el mismo elija lo que elija, copy neutral evita depender de
 * esa idea para comunicar el punto (ver auditoría de precio único).
 */
function formatInstallmentDisplayLabel(plan: InstallmentDisplayPlan): string {
  return `Hasta ${plan.count} cuotas de ${formatCommercialPrice(plan.installmentAmount)}`
}

/**
 * Planes elegibles de cara al cliente, en orden ascendente de cuotas.
 * `price` es el PRECIO PÚBLICO efectivamente mostrado (puede diferir de
 * `producto.precio` cuando hay variante/condicionado con su propio precio)
 * -- nunca se asume `producto.precio` acá. Puramente informativo: ver
 * `getPlainInstallmentAmount`.
 */
export function getEligibleInstallmentDisplayPlans(
  product: EligibleInstallmentsProduct,
  price: number,
): InstallmentDisplayPlan[] {
  return getEligibleInstallmentCounts(product)
    .map((count) => {
      const installmentAmount = getPlainInstallmentAmount(price, count)
      return installmentAmount === null ? null : { count, installmentAmount }
    })
    .filter((plan): plan is InstallmentDisplayPlan => plan !== null)
}

/**
 * Líneas de cara al cliente, ej. "Hasta 3 cuotas de $25.000". Una línea por
 * cada modalidad habilitada, en orden ascendente de cuotas.
 */
export function getInstallmentPlanLabels(
  product: EligibleInstallmentsProduct,
  price: number,
): string[] {
  return getEligibleInstallmentDisplayPlans(product, price).map(
    formatInstallmentDisplayLabel,
  )
}

/**
 * La MAYOR modalidad de cuotas habilitada para el producto, ya formateada
 * ("Hasta 6 cuotas de $X"). Pensada para superficies compactas (ProductCard,
 * PDP/Quick View) donde mostrar las 3 modalidades a la vez sobrecarga la UI
 * -- el checkout sigue mostrando todas las modalidades reales vía
 * `getInstallmentPlanLabels`/`getEligibleInstallmentCounts`. `null` si el
 * producto no tiene ninguna modalidad habilitada.
 */
export function getMaxInstallmentPlanLabel(
  product: EligibleInstallmentsProduct,
  price: number,
): string | null {
  const plans = getEligibleInstallmentDisplayPlans(product, price)
  const maxPlan = plans[plans.length - 1]
  return maxPlan ? formatInstallmentDisplayLabel(maxPlan) : null
}
