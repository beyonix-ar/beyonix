import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateMarginFromPrice,
  calculatePriceFromTargetMargin,
  calculateTargetMarginPrice,
  getPaymentScenarioRates,
  simulateProductProfitability,
} from "./product-pricing.ts"
import type { InstallmentsFinancingConfig } from "../products/installments.ts"

const REAL_CONFIG: InstallmentsFinancingConfig = {
  baseProcessingPercent: 6.42,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}

test("calculateMarginFromPrice: margen SOBRE VENTA, no markup sobre costo", () => {
  // $5.000 de ganancia sobre $20.000 de precio = 25%, no 5000/15000 (33,3%, que sería markup).
  const { profitAmount, marginPercent } = calculateMarginFromPrice(20_000, 15_000, 0)
  assert.equal(profitAmount, 5_000)
  assert.equal(marginPercent, 25)
})

test("calculateMarginFromPrice descuenta primero el costo variable del medio de pago", () => {
  // Transferencia 10%: cobra 18.000 netos, menos costo 15.000 = 3.000 (15%).
  const { profitAmount, marginPercent } = calculateMarginFromPrice(20_000, 15_000, 10)
  assert.equal(profitAmount, 3_000)
  assert.equal(marginPercent, 15)
})

test("calculateMarginFromPrice: margen negativo se devuelve tal cual, no null ni excepción", () => {
  const { profitAmount, marginPercent } = calculateMarginFromPrice(10_000, 15_000, 0)
  assert.equal(profitAmount, -5_000)
  assert.equal(marginPercent, -50)
})

test("calculatePriceFromTargetMargin: margen 0% -> precio iguala exactamente al costo (sin tasa variable)", () => {
  const price = calculatePriceFromTargetMargin(15_000, 0, 0)
  assert.equal(price, 15_000)
})

test("calculatePriceFromTargetMargin: margen sobre venta correcto, no costo*(1+margen) (markup)", () => {
  const price = calculatePriceFromTargetMargin(15_000, 40, 0)
  // markup sería 15000*1.4 = 21000; margen sobre venta da 25000.
  assert.equal(price, 25_000)
  assert.notEqual(price, 15_000 * 1.4)

  const { marginPercent } = calculateMarginFromPrice(price!, 15_000, 0)
  assert.equal(marginPercent, 40)
})

test("calculatePriceFromTargetMargin con tasa variable: el margen resultante sigue dando exacto antes de redondear", () => {
  const price = calculatePriceFromTargetMargin(15_000, 40, 10)
  assert.equal(price, 30_000)

  const { marginPercent } = calculateMarginFromPrice(price!, 15_000, 10)
  assert.equal(marginPercent, 40)
})

test("calculatePriceFromTargetMargin: costo inválido o margen+tasa imposibles devuelven null", () => {
  assert.equal(calculatePriceFromTargetMargin(0, 40, 0), null)
  assert.equal(calculatePriceFromTargetMargin(-100, 40, 0), null)
  assert.equal(calculatePriceFromTargetMargin(15_000, 95, 10), null) // 1 - 0.10 - 0.95 <= 0
  assert.equal(calculatePriceFromTargetMargin(15_000, -5, 0), null)
})

test("getPaymentScenarioRates: sin cuotas habilitadas, sólo transferencia y MP 1 pago", () => {
  const scenarios = getPaymentScenarioRates([], REAL_CONFIG)
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    ["transferencia", "mp_unico"],
  )
  assert.equal(scenarios[0].ratePercent, 10)
  assert.equal(scenarios[1].ratePercent, 8) // ceil(6.42 * 1.21) = ceil(7.7682)
})

test("getPaymentScenarioRates: agrega una entrada por cada cuota habilitada, en orden ascendente", () => {
  const scenarios = getPaymentScenarioRates([6, 2, 3], REAL_CONFIG)
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    ["transferencia", "mp_unico", "mp_2", "mp_3", "mp_6"],
  )
  assert.deepEqual(
    scenarios.map((scenario) => scenario.ratePercent),
    [10, 8, 18, 21, 31],
  )
})

test("simulateProductProfitability: costo desconocido devuelve null, nunca inventa un costo", () => {
  assert.equal(
    simulateProductProfitability({
      price: 29_900,
      cost: null,
      eligibleInstallmentCounts: [],
      config: REAL_CONFIG,
    }),
    null,
  )
})

test("simulateProductProfitability: sin cuotas habilitadas, transferencia (10%) es el PEOR escenario, no MP 1 pago (8%)", () => {
  // No asumir que transferencia es la modalidad más rentable: calcularlo.
  const result = simulateProductProfitability({
    price: 29_900,
    cost: 15_000,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
  })
  assert.ok(result)
  assert.equal(result!.worstCase.id, "transferencia")
})

test("simulateProductProfitability: con cuotas habilitadas, la modalidad de más cuotas pasa a ser el peor escenario", () => {
  const result = simulateProductProfitability({
    price: 29_900,
    cost: 15_000,
    eligibleInstallmentCounts: [2, 3, 6],
    config: REAL_CONFIG,
  })
  assert.ok(result)
  assert.equal(result!.worstCase.id, "mp_6")
})

test("simulateProductProfitability: producto con modalidades parciales (sólo 2 cuotas) -- 2 cuotas es el peor, no 6", () => {
  const result = simulateProductProfitability({
    price: 29_900,
    cost: 15_000,
    eligibleInstallmentCounts: [2],
    config: REAL_CONFIG,
  })
  assert.ok(result)
  assert.equal(result!.worstCase.id, "mp_2")
  assert.deepEqual(
    result!.scenarios.map((scenario) => scenario.id),
    ["transferencia", "mp_unico", "mp_2"],
  )
})

test("simulateProductProfitability: precio manual por debajo del costo -- margen negativo en todos los escenarios, sin excepción", () => {
  const result = simulateProductProfitability({
    price: 10_000,
    cost: 15_000,
    eligibleInstallmentCounts: [2],
    config: REAL_CONFIG,
  })
  assert.ok(result)
  for (const scenario of result!.scenarios) {
    assert.ok(scenario.marginPercent < 0)
  }
})

test("calculateTargetMarginPrice: precio único que garantiza el margen objetivo en el peor escenario (6 cuotas)", () => {
  const result = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [2, 3, 6],
    config: REAL_CONFIG,
  })
  assert.ok(result)
  assert.equal(result!.worstCaseScenario.id, "mp_6")
  // Matemático: 15000 / (1 - 0.31 - 0.40) = 15000 / 0.29 = 51724.13... -> comercial $51.900.
  assert.equal(result!.commercialPrice, 51_900)
  // El margen REAL post-redondeo es >= al objetivo (redondear hacia arriba nunca lo perfora).
  assert.ok(result!.resultingMarginPercent >= 40)
  assert.ok(result!.resultingMarginPercent < 41)
})

test("calculateTargetMarginPrice: con el mismo precio único, transferencia y MP 1 pago quedan con margen MAYOR al objetivo", () => {
  const result = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [2, 3, 6],
    config: REAL_CONFIG,
  })
  assert.ok(result)

  const simulation = simulateProductProfitability({
    price: result!.commercialPrice,
    cost: 15_000,
    eligibleInstallmentCounts: [2, 3, 6],
    config: REAL_CONFIG,
  })
  assert.ok(simulation)

  const transferencia = simulation!.scenarios.find((scenario) => scenario.id === "transferencia")
  const seisCuotas = simulation!.scenarios.find((scenario) => scenario.id === "mp_6")
  assert.ok(transferencia!.marginPercent > seisCuotas!.marginPercent)
  assert.ok(transferencia!.marginPercent > 40)
})

test("calculateTargetMarginPrice: margen 0% como objetivo es válido", () => {
  const result = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 0,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
  })
  assert.ok(result)
  assert.ok(result!.resultingMarginPercent >= 0)
})

test("calculateTargetMarginPrice: costo inválido o margen objetivo inalcanzable para el peor escenario devuelven null", () => {
  assert.equal(
    calculateTargetMarginPrice({
      cost: 0,
      targetMarginPercent: 40,
      eligibleInstallmentCounts: [],
      config: REAL_CONFIG,
    }),
    null,
  )
  assert.equal(
    calculateTargetMarginPrice({
      cost: 15_000,
      targetMarginPercent: 95,
      eligibleInstallmentCounts: [2, 3, 6], // peor escenario 31% + 95% > 100%
      config: REAL_CONFIG,
    }),
    null,
  )
})

test("cambiar la configuración financiera cambia el precio calculado, sin nada hardcodeado", () => {
  const cheaperConfig: InstallmentsFinancingConfig = {
    ...REAL_CONFIG,
    surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 5 }, // 6 cuotas mucho más barata
  }

  const withRealConfig = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [6],
    config: REAL_CONFIG,
  })
  const withCheaperConfig = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [6],
    config: cheaperConfig,
  })

  assert.ok(withRealConfig)
  assert.ok(withCheaperConfig)
  assert.notEqual(withRealConfig!.commercialPrice, withCheaperConfig!.commercialPrice)
  assert.ok(withCheaperConfig!.commercialPrice < withRealConfig!.commercialPrice)
})
