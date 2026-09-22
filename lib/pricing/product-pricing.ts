import { roundUpToCommercialEnding } from "../store-config.ts"
import {
  INSTALLMENT_COUNTS,
  getEffectiveInstallmentPercent,
  getSinglePaymentEffectivePercent,
  type InstallmentCount,
  type InstallmentsFinancingConfig,
} from "../products/installments.ts"
import { getFinancedPrice } from "./financed-pricing.ts"

/**
 * "discount": la tasa reduce lo que el cliente efectivamente paga (ej.
 * transferencia) -- el ingreso real de la operación YA es precio*(1-tasa).
 * "fee": el cliente paga el precio público entero; la tasa es lo que se
 * resigna al cobrar (comisión de Mercado Pago) y el ingreso de la operación
 * sigue siendo el precio público. Ambas restan lo mismo de la ganancia, pero
 * el margen ("ganancia / ingreso de la operación") se calcula sobre bases
 * distintas -- confundirlas infla o exprime el margen mostrado sin que el
 * negocio real haya cambiado.
 */
export type PaymentScenarioKind = "discount" | "fee"

/**
 * "cash": el precio de este escenario es el CONTADO (transferencia y MP 1
 * pago son descuentos/comisiones sobre el mismo precio de contado). "financed":
 * el precio de este escenario es el FINANCIADO (constante, calculado con la
 * cuota MÁXIMA habilitada -- ver `lib/pricing/financed-pricing.ts`), nunca el
 * contado. Por construcción del gross-up, la ganancia en PESOS de la cuota
 * máxima es idéntica a la de contado (financedPrice*(1-feeRate) = cashPrice
 * exacto) -- su margen % es más bajo sólo porque se divide por un ingreso
 * mayor, no porque haya menos ganancia real. Por eso los escenarios
 * "financed" NUNCA participan de "peor escenario" ni de la resolución de
 * precio por margen objetivo (ver `calculateTargetMarginPrice`): son
 * puramente informativos.
 */
export type PaymentScenarioPriceBasis = "cash" | "financed"

export interface PaymentScenarioRate {
  id: string
  label: string
  ratePercent: number
  kind: PaymentScenarioKind
  priceBasis: PaymentScenarioPriceBasis
}

export interface PaymentScenarioResult extends PaymentScenarioRate {
  /** Precio efectivamente usado en este escenario (contado o financiado, según `priceBasis`). */
  price: number
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
 * Margen SOBRE VENTA (no markup sobre costo): profit / ingreso real de la
 * operación, no profit / cost. `variableCostRatePercent` es la fracción del
 * precio que se resigna en esa operación (comisión MP efectiva o descuento de
 * transferencia) -- siempre reduce el precio antes de restar el costo fijo,
 * sin importar el `kind`.
 *
 * Lo que SÍ depende de `kind` es la base del margen (el denominador): para
 * "discount" el cliente pagó menos (el ingreso real ya es precio*(1-tasa));
 * para "fee" el cliente pagó el precio público entero (el ingreso real es el
 * precio público, la tasa sólo resigna ganancia). Usar siempre el precio
 * público como base -- como se hacía antes -- infla el margen mostrado de
 * transferencia, porque lo divide por un ingreso mayor al que realmente hubo.
 */
export function calculateMarginFromPrice(
  price: number,
  cost: number,
  variableCostRatePercent: number,
  kind: PaymentScenarioKind = "fee",
): { profitAmount: number; marginPercent: number } {
  const safePrice = Number.isFinite(price) ? price : 0
  const safeCost = Number.isFinite(cost) ? cost : 0
  const rate = Number.isFinite(variableCostRatePercent) ? variableCostRatePercent / 100 : 0

  const netAmount = safePrice * (1 - rate)
  const profitAmount = netAmount - safeCost
  const revenue = kind === "discount" ? netAmount : safePrice
  const marginPercent = revenue > 0 ? (profitAmount / revenue) * 100 : 0

  return { profitAmount, marginPercent }
}

/**
 * Despeja el precio necesario para que, después de descontar la tasa
 * variable del medio de pago, quede exactamente `targetMarginPercent` de
 * margen SOBRE VENTA (no `cost * (1 + margin)`, que sería markup). La
 * ecuación cambia según `kind` porque la base del margen es distinta (ver
 * `calculateMarginFromPrice`):
 *
 *   fee:      margen = (1 - r) - costo/precio       => precio = costo / (1 - r - margen)
 *   discount: margen = 1 - costo/(precio*(1 - r))   => precio = costo / ((1 - margen) * (1 - r))
 *
 * Mismo patrón matemático de gross-up que usaba (hasta la corrección de
 * precio público único) el checkout para el total financiado -- acá vive
 * legítimamente porque este precio es interno de Admin (objetivo de
 * rentabilidad), nunca un recargo que vea o pague el cliente por elegir
 * cuotas. `null` si el costo no es válido o si el margen objetivo + la tasa
 * variable hacen la ecuación imposible (>=100% de la base).
 */
export function calculatePriceFromTargetMargin(
  cost: number,
  targetMarginPercent: number,
  variableCostRatePercent: number,
  kind: PaymentScenarioKind = "fee",
): number | null {
  if (!Number.isFinite(cost) || cost <= 0) return null
  if (!Number.isFinite(targetMarginPercent) || targetMarginPercent < 0) return null
  if (!Number.isFinite(variableCostRatePercent)) return null

  const marginFactor = 1 - targetMarginPercent / 100

  if (kind === "discount") {
    // margen = 1 - costo/ingreso, ingreso = precio*(1-tasa)
    //   => ingreso = costo / (1-margen)  =>  precio = costo / ((1-margen)*(1-tasa))
    const rateFactor = 1 - variableCostRatePercent / 100
    if (marginFactor <= 0 || rateFactor <= 0) return null
    return cost / (marginFactor * rateFactor)
  }

  const denominator = marginFactor - variableCostRatePercent / 100
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
  transferDiscountPercent: number,
): PaymentScenarioRate[] {
  const scenarios: PaymentScenarioRate[] = [
    {
      id: "transferencia",
      label: "Transferencia",
      ratePercent: transferDiscountPercent,
      kind: "discount",
      priceBasis: "cash",
    },
    {
      id: "mp_unico",
      label: "Mercado Pago — 1 pago",
      ratePercent: getSinglePaymentEffectivePercent(config),
      kind: "fee",
      priceBasis: "cash",
    },
  ]

  for (const count of INSTALLMENT_COUNTS) {
    if (!eligibleInstallmentCounts.includes(count)) continue
    scenarios.push({
      id: `mp_${count}`,
      label: `Mercado Pago — ${count} cuotas`,
      ratePercent: getEffectiveInstallmentPercent(count, config),
      kind: "fee",
      priceBasis: "financed",
    })
  }

  return scenarios
}

export interface SimulateProductProfitabilityInput {
  /** Precio de CONTADO (nunca el financiado -- ese se deriva acá mismo para la cuota máxima). */
  price: number
  /** `null`/desconocido cuando el producto no tiene costo cargado en Compras -- nunca se inventa un costo. */
  cost: number | null
  eligibleInstallmentCounts: InstallmentCount[]
  config: InstallmentsFinancingConfig
  transferDiscountPercent: number
}

/**
 * Rentabilidad de un precio de contado ya definido (modo manual o margen
 * objetivo), desglosada por medio de pago. Los escenarios de cuotas usan el
 * precio FINANCIADO (constante, derivado de la cuota máxima habilitada), no
 * el de contado -- ver `PaymentScenarioPriceBasis`.
 *
 * `worstCase` es el escenario con MENOR margen resultante ENTRE LOS DE BASE
 * CONTADO (transferencia/MP 1 pago) -- el piso real de rentabilidad de ese
 * precio. Los escenarios financiados quedan afuera de "peor caso" a
 * propósito: por construcción del gross-up, su ganancia en pesos es igual o
 * mayor a la de contado; su margen % es más bajo sólo porque se divide por
 * un ingreso mayor, nunca por pérdida real (no es un caso "peor", es
 * aritmética distinta). `null` sólo si el costo es desconocido.
 */
export function simulateProductProfitability({
  price,
  cost,
  eligibleInstallmentCounts,
  config,
  transferDiscountPercent,
}: SimulateProductProfitabilityInput): ProductProfitabilitySimulation | null {
  if (cost == null || !Number.isFinite(cost) || cost < 0) return null

  const maxEligibleCount = eligibleInstallmentCounts.length
    ? (Math.max(...eligibleInstallmentCounts) as InstallmentCount)
    : null
  const financedPrice = getFinancedPrice(price, maxEligibleCount, config)

  const scenarios = getPaymentScenarioRates(
    eligibleInstallmentCounts,
    config,
    transferDiscountPercent,
  ).map((scenario) => {
    const scenarioPrice =
      scenario.priceBasis === "financed" && financedPrice != null
        ? financedPrice
        : price
    const { profitAmount, marginPercent } = calculateMarginFromPrice(
      scenarioPrice,
      cost,
      scenario.ratePercent,
      scenario.kind,
    )
    return { ...scenario, price: scenarioPrice, profitAmount, marginPercent }
  })

  const cashBasisScenarios = scenarios.filter((scenario) => scenario.priceBasis === "cash")
  const worstCase = cashBasisScenarios.reduce((worst, current) =>
    current.marginPercent < worst.marginPercent ? current : worst,
  )

  return { scenarios, worstCase }
}

export interface CalculateTargetMarginPriceInput {
  cost: number
  targetMarginPercent: number
  eligibleInstallmentCounts: InstallmentCount[]
  config: InstallmentsFinancingConfig
  transferDiscountPercent: number
}

/**
 * Precio de CONTADO que garantiza (como mínimo) el margen objetivo en
 * transferencia y MP 1 pago -- las únicas dos modalidades que comparten base
 * de precio (contado) y por lo tanto son comparables en margen %. `null` si
 * el costo no es válido o si el margen objetivo es inalcanzable en alguna de
 * las dos.
 *
 * Las modalidades de cuotas NO participan de esta resolución: su precio
 * (financiado, derivado de la cuota máxima habilitada) se calcula aparte y,
 * por construcción del gross-up, siempre preserva como mínimo la misma
 * ganancia en PESOS que el contado -- nunca hace falta "proteger" ese
 * escenario con un precio más alto (ver `simulateProductProfitability`).
 *
 * El "peor escenario" NO es simplemente el de mayor `ratePercent`: una tasa
 * "discount" (transferencia) y una "fee" (Mercado Pago) definen el margen
 * sobre bases distintas (ver `calculateMarginFromPrice`), así que una tasa
 * nominal menor puede igual exigir un precio mayor para el mismo margen
 * objetivo. Por eso se resuelve el precio que exige CADA modalidad por
 * separado y se toma el mayor -- ese precio, por construcción, deja a la otra
 * modalidad con margen igual o superior al objetivo.
 *
 * El precio matemático se redondea hacia arriba a la terminación comercial
 * ($...900) y el margen que se devuelve es el REAL resultante después de ese
 * redondeo (recalculado sobre ambas modalidades, no sólo la que fijó el
 * precio), no el objetivo sin redondear.
 */
export function calculateTargetMarginPrice({
  cost,
  targetMarginPercent,
  eligibleInstallmentCounts,
  config,
  transferDiscountPercent,
}: CalculateTargetMarginPriceInput): TargetMarginPriceResult | null {
  if (!Number.isFinite(cost) || cost <= 0) return null

  const rates = getPaymentScenarioRates(
    eligibleInstallmentCounts,
    config,
    transferDiscountPercent,
  ).filter((scenario) => scenario.priceBasis === "cash")

  let bindingScenario: PaymentScenarioRate | null = null
  let requiredPrice = -Infinity

  for (const scenario of rates) {
    const scenarioPrice = calculatePriceFromTargetMargin(
      cost,
      targetMarginPercent,
      scenario.ratePercent,
      scenario.kind,
    )
    // Si el margen objetivo es inalcanzable para CUALQUIER modalidad de
    // contado, no hay un precio único que cumpla la garantía prometida.
    if (scenarioPrice == null) return null

    if (scenarioPrice > requiredPrice) {
      requiredPrice = scenarioPrice
      bindingScenario = scenario
    }
  }

  if (!bindingScenario || !Number.isFinite(requiredPrice)) return null

  const commercialPrice = roundUpToCommercialEnding(requiredPrice)

  const worstCase = rates
    .map((scenario) => ({
      scenario,
      ...calculateMarginFromPrice(commercialPrice, cost, scenario.ratePercent, scenario.kind),
    }))
    .reduce((worst, current) => (current.marginPercent < worst.marginPercent ? current : worst))

  return {
    commercialPrice,
    worstCaseScenario: worstCase.scenario,
    resultingMarginPercent: worstCase.marginPercent,
    resultingProfitAmount: worstCase.profitAmount,
  }
}
