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

export interface InstallmentPlan {
  count: InstallmentCount
  /** % efectivo aplicado (base + costo de cuotas, con IVA, redondeado hacia arriba al entero como margen de seguridad). Nunca se le muestra al cliente. */
  percent: number
  installmentAmount: number
  totalFinanced: number
}

interface EligibleInstallmentsProduct {
  cuotas_2_habilitadas?: boolean
  cuotas_3_habilitadas?: boolean
  cuotas_6_habilitadas?: boolean
}

const ROUNDING_EPSILON = 1e-6

/**
 * Redondea hacia arriba al próximo múltiplo de $100. Un valor ya exacto en
 * múltiplo de 100 no sube (usa un epsilon para no dispararse por arrastre
 * de punto flotante, ej. 28100.00000000003).
 */
export function roundUpToCommercialHundred(value: number): number {
  if (!Number.isFinite(value)) return 0
  // "|| 0" normaliza -0 (ej. cuando value es 0 y el epsilon lo empuja
  // apenas debajo de cero antes del ceil) a 0 positivo.
  return Math.ceil((value - ROUNDING_EPSILON) / 100) * 100 || 0
}

/**
 * % efectivo que hay que aplicar sobre el precio base para que, después de
 * que Mercado Pago cobre su costo real (procesamiento + costo por cuotas,
 * con IVA), BEYONIX preserve la base económica que pretendía cobrar.
 * Redondea hacia arriba al entero como margen de seguridad -- nunca se
 * muestra este número al cliente.
 */
export function getEffectiveInstallmentPercent(
  count: InstallmentCount,
  config: InstallmentsFinancingConfig,
): number {
  const rawPercent =
    config.baseProcessingPercent + config.surchargePercentByCount[count]
  const withIva = rawPercent * (1 + config.ivaPercent / 100)
  return Math.ceil(withIva - ROUNDING_EPSILON)
}

/**
 * precio_financiado = precio_base / (1 - porcentaje). Compensa el
 * porcentaje descontado en vez de simplemente sumarlo.
 */
export function calculateFinancedTotal(
  baseAmount: number,
  percent: number,
): number {
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return 0
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) return baseAmount
  return baseAmount / (1 - percent / 100)
}

/**
 * Cuota comercial: redondea la CUOTA hacia arriba a $100 y reconstruye el
 * total multiplicando por la cantidad de cuotas (nunca al revés).
 */
export function calculateInstallmentPlan(
  baseAmount: number,
  count: InstallmentCount,
  config: InstallmentsFinancingConfig,
): InstallmentPlan | null {
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return null

  const percent = getEffectiveInstallmentPercent(count, config)
  const financedTotalRaw = calculateFinancedTotal(baseAmount, percent)
  const installmentAmount = roundUpToCommercialHundred(financedTotalRaw / count)
  const totalFinanced = installmentAmount * count

  return { count, percent, installmentAmount, totalFinanced }
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
 * Líneas de cara al cliente, ej. "Hasta 3 cuotas sin interés de $31.700".
 * Nunca incluye porcentaje, comisión ni "financiado" -- sólo cuenta de
 * cuotas y monto de cada una. `price` es el precio efectivamente mostrado
 * (puede diferir de `producto.precio` cuando hay variante/condicionado con
 * su propio precio) -- nunca se asume `producto.precio` acá.
 *
 * "Hasta N" y no "N" a secas: Checkout Pro configura `installments` como
 * TOPE ofrecido, no como cantidad obligatoria -- según el medio de pago,
 * Mercado Pago puede terminar ofreciéndole al comprador menos cuotas que N
 * (hasta 1 pago) por el mismo monto. "N cuotas de $X" sin matizar sería una
 * promesa que la propia preferencia de Mercado Pago no puede garantizar.
 */
export function getInstallmentPlanLabels(
  product: EligibleInstallmentsProduct,
  price: number,
  config: InstallmentsFinancingConfig,
): string[] {
  const eligibleCounts = getEligibleInstallmentCounts(product)

  return eligibleCounts
    .map((count) => {
      const plan = calculateInstallmentPlan(price, count, config)
      if (!plan) return null
      return `Hasta ${count} cuotas sin interés de ${formatCommercialPrice(plan.installmentAmount)}`
    })
    .filter((label): label is string => label !== null)
}
