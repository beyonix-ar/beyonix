import { TRANSFER_DISCOUNT, roundUpToCommercialEnding } from "../store-config.ts"
import {
  INSTALLMENT_COUNTS,
  getEffectiveInstallmentPercent,
  getSinglePaymentEffectivePercent,
  type InstallmentCount,
  type InstallmentsFinancingConfig,
} from "../products/installments.ts"

export interface PaymentScenarioRate {
  id: string
  label: string
  ratePercent: number
}

export interface PaymentScenarioResult extends PaymentScenarioRate {
  profitAmount: number
  marginPercent: number
}

export interface ProductProfitabilitySimulation {
  scenarios: PaymentScenarioResult[]
  worstCase: PaymentScenarioResult
}

export interface TargetMarginPriceResult {
  commercialPrice: number
  worstCaseScenario: PaymentScenarioRate
  resultingMarginPercent: number
  resultingProfitAmount: number
}

/**
 * Margen SOBRE VENTA (no markup sobre costo): profit / price, no profit /
 * cost. `variableCostRatePercent` es la fracción del precio que se lleva el
 * medio de pago (comisión MP efectiva o descuento de transferencia) --
 * siempre reduce el precio antes de restar el costo fijo.
 */
export function calculateMarginFromPrice(
  price: number,
  cost: number,
  variableCostRatePercent: number,
): { profitAmount: number; marginPercent: number } {
  const safePrice = Number.isFinite(price) ? price : 0
  const safeCost = Number.isFinite(cost) ? cost : 0
  const rate = Number.isFinite(variableCostRatePercent) ? variableCostRatePercent / 100 : 0

  const profitAmount = safePrice * (1 - rate) - safeCost
  const marginPercent = safePrice > 0 ? (profitAmount / safePrice) * 100 : 0

  return { profitAmount, marginPercent }
}

/**
 * Despeja el precio público necesario para que, después de descontar el
 * costo variable del medio de pago, quede exactamente `targetMarginPercent`
 * de margen SOBRE VENTA (no `cost * (1 + margin)`, que sería markup).
 *
 *   margen = (1 - r) - costo/precio  =>  precio = costo / (1 - r - margen)
 *
 * Mismo patrón matemático que `calculateFinancedTotal` en
 * lib/products/installments.ts (gross-up para preservar una base neta),
 * generalizado para incluir el margen como otro componente a cubrir.
 * `null` si el costo no es válido o si el margen objetivo + la tasa
 * variable hacen la ecuación imposible (>=100% del precio).
 */
export function calculatePriceFromTargetMargin(
  cost: number,
  targetMarginPercent: number,
  variableCostRatePercent: number,
): number | null {
  if (!Number.isFinite(cost) || cost <= 0) return null
  if (!Number.isFinite(targetMarginPercent) || targetMarginPercent < 0) return null
  if (!Number.isFinite(variableCostRatePercent)) return null

  const denominator = 1 - variableCostRatePercent / 100 - targetMarginPercent / 100
  if (denominator <= 0) return null

  return cost / denominator
}

/**
 * Arma la lista de escenarios de pago con su tasa de costo variable, en el
 * mismo orden en que se muestran al admin: Transferencia y Mercado Pago 1
 * pago siempre están disponibles (no dependen de las cuotas habilitadas del
 * producto); las cuotas sólo aparecen si están habilitadas. Reutiliza la
 * config financiera global -- nada hardcodeado acá.
 */
export function getPaymentScenarioRates(
  eligibleInstallmentCounts: InstallmentCount[],
  config: InstallmentsFinancingConfig,
): PaymentScenarioRate[] {
  const scenarios: PaymentScenarioRate[] = [
    { id: "transferencia", label: "Transferencia", ratePercent: TRANSFER_DISCOUNT * 100 },
    {
      id: "mp_unico",
      label: "Mercado Pago — 1 pago",
      ratePercent: getSinglePaymentEffectivePercent(config),
    },
  ]

  for (const count of INSTALLMENT_COUNTS) {
    if (!eligibleInstallmentCounts.includes(count)) continue
    scenarios.push({
      id: `mp_${count}`,
      label: `Mercado Pago — ${count} cuotas`,
      ratePercent: getEffectiveInstallmentPercent(count, config),
    })
  }

  return scenarios
}

export interface SimulateProductProfitabilityInput {
  price: number
  /** `null`/desconocido cuando el producto no tiene costo cargado en Compras -- nunca se inventa un costo. */
  cost: number | null
  eligibleInstallmentCounts: InstallmentCount[]
  config: InstallmentsFinancingConfig
}

/**
 * Rentabilidad de un precio ya definido (modo manual), desglosada por medio
 * de pago. `worstCase` es el escenario con MENOR margen resultante (no
 * necesariamente el de mayor tasa nominal, aunque en la práctica coinciden)
 * -- es el piso real de rentabilidad de ese precio. `null` sólo si el costo
 * es desconocido.
 */
export function simulateProductProfitability({
  price,
  cost,
  eligibleInstallmentCounts,
  config,
}: SimulateProductProfitabilityInput): ProductProfitabilitySimulation | null {
  if (cost == null || !Number.isFinite(cost) || cost < 0) return null

  const scenarios = getPaymentScenarioRates(eligibleInstallmentCounts, config).map(
    (scenario) => {
      const { profitAmount, marginPercent } = calculateMarginFromPrice(
        price,
        cost,
        scenario.ratePercent,
      )
      return { ...scenario, profitAmount, marginPercent }
    },
  )

  const worstCase = scenarios.reduce((worst, current) =>
    current.marginPercent < worst.marginPercent ? current : worst,
  )

  return { scenarios, worstCase }
}

export interface CalculateTargetMarginPriceInput {
  cost: number
  targetMarginPercent: number
  eligibleInstallmentCounts: InstallmentCount[]
  config: InstallmentsFinancingConfig
}

/**
 * Precio público único que garantiza (como mínimo) el margen objetivo en el
 * escenario de pago MÁS CARO habilitado (mayor tasa variable) -- las
 * modalidades más baratas quedan con margen mayor al objetivo, nunca menor.
 * El precio matemático se redondea hacia arriba a la terminación comercial
 * ($...900) y el margen que se devuelve es el REAL resultante después de ese
 * redondeo, no el objetivo sin redondear. `null` si el costo no es válido o
 * el margen objetivo es matemáticamente inalcanzable para la tasa del peor
 * escenario.
 */
export function calculateTargetMarginPrice({
  cost,
  targetMarginPercent,
  eligibleInstallmentCounts,
  config,
}: CalculateTargetMarginPriceInput): TargetMarginPriceResult | null {
  if (!Number.isFinite(cost) || cost <= 0) return null

  const rates = getPaymentScenarioRates(eligibleInstallmentCounts, config)
  const worstCaseScenario = rates.reduce((worst, current) =>
    current.ratePercent > worst.ratePercent ? current : worst,
  )

  const rawPrice = calculatePriceFromTargetMargin(
    cost,
    targetMarginPercent,
    worstCaseScenario.ratePercent,
  )
  if (rawPrice == null) return null

  const commercialPrice = roundUpToCommercialEnding(rawPrice)
  const { profitAmount, marginPercent } = calculateMarginFromPrice(
    commercialPrice,
    cost,
    worstCaseScenario.ratePercent,
  )

  return {
    commercialPrice,
    worstCaseScenario,
    resultingMarginPercent: marginPercent,
    resultingProfitAmount: profitAmount,
  }
}
