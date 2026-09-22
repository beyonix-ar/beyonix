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
const TRANSFER_DISCOUNT_PERCENT = 10

test("calculateMarginFromPrice: margen SOBRE VENTA, no markup sobre costo", () => {
  // $5.000 de ganancia sobre $20.000 de precio = 25%, no 5000/15000 (33,3%, que sería markup).
  const { profitAmount, marginPercent } = calculateMarginFromPrice(20_000, 15_000, 0)
  assert.equal(profitAmount, 5_000)
  assert.equal(marginPercent, 25)
})

test("calculateMarginFromPrice (fee, ej. Mercado Pago): la tasa resta ganancia pero el margen se calcula sobre el precio público completo", () => {
  const { profitAmount, marginPercent } = calculateMarginFromPrice(20_000, 15_000, 10, "fee")
  assert.equal(profitAmount, 3_000)
  assert.equal(marginPercent, 15)
})

test("calculateMarginFromPrice (discount, ej. Transferencia): el margen se calcula sobre lo que el cliente REALMENTE pagó, no sobre el precio público", () => {
  const { profitAmount, marginPercent } = calculateMarginFromPrice(20_000, 8_000, 20, "discount")
  assert.equal(profitAmount, 8_000)
  assert.equal(marginPercent, 50)
})

test("AUDITORÍA: usar el precio público como base para Transferencia (como se hacía antes) infla/exprime el margen mostrado", () => {
  const asFee = calculateMarginFromPrice(20_000, 8_000, 20, "fee")
  const asDiscount = calculateMarginFromPrice(20_000, 8_000, 20, "discount")
  assert.equal(asFee.profitAmount, asDiscount.profitAmount)
  assert.notEqual(asFee.marginPercent, asDiscount.marginPercent)
  assert.equal(asFee.marginPercent, 40)
  assert.equal(asDiscount.marginPercent, 50)
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
  assert.equal(calculatePriceFromTargetMargin(15_000, 95, 10), null)
  assert.equal(calculatePriceFromTargetMargin(15_000, -5, 0), null)
})

test("calculatePriceFromTargetMargin (discount): despeja sobre el neto que paga el cliente, no sobre el precio público", () => {
  const price = calculatePriceFromTargetMargin(8_000, 50, 20, "discount")
  assert.equal(price, 20_000)

  const { marginPercent } = calculateMarginFromPrice(price!, 8_000, 20, "discount")
  assert.equal(marginPercent, 50)
})

test("AUDITORÍA: la misma tasa nominal exige precios distintos según sea descuento o comisión -- por eso no alcanza con comparar tasas para elegir el peor escenario", () => {
  const asFeePrice = calculatePriceFromTargetMargin(8_000, 50, 20, "fee")
  const asDiscountPrice = calculatePriceFromTargetMargin(8_000, 50, 20, "discount")
  assert.equal(asFeePrice, 8_000 / 0.3)
  assert.equal(asDiscountPrice, 20_000)
  assert.ok(asFeePrice! > asDiscountPrice!)
})

test("getPaymentScenarioRates: sin cuotas habilitadas, sólo transferencia y MP 1 pago -- ambas de base CONTADO", () => {
  const scenarios = getPaymentScenarioRates([], REAL_CONFIG, TRANSFER_DISCOUNT_PERCENT)
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    ["transferencia", "mp_unico"],
  )
  assert.equal(scenarios[0].ratePercent, 10)
  assert.equal(scenarios[1].ratePercent, 8) // ceil(6.42 * 1.21) = ceil(7.7682)
  assert.equal(scenarios[0].kind, "discount")
  assert.equal(scenarios[1].kind, "fee")
  assert.ok(scenarios.every((scenario) => scenario.priceBasis === "cash"))
})

test("getPaymentScenarioRates: agrega una entrada FINANCIADA por cada cuota habilitada, en orden ascendente", () => {
  const scenarios = getPaymentScenarioRates([6, 2, 3], REAL_CONFIG, TRANSFER_DISCOUNT_PERCENT)
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    ["transferencia", "mp_unico", "mp_2", "mp_3", "mp_6"],
  )
  assert.deepEqual(
    scenarios.map((scenario) => scenario.ratePercent),
    [10, 8, 18, 21, 31],
  )
  assert.deepEqual(
    scenarios.map((scenario) => scenario.priceBasis),
    ["cash", "cash", "financed", "financed", "financed"],
  )
})

test("simulateProductProfitability: costo desconocido devuelve null, nunca inventa un costo", () => {
  assert.equal(
    simulateProductProfitability({
      price: 29_900,
      cost: null,
      eligibleInstallmentCounts: [],
      config: REAL_CONFIG,
      transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
    }),
    null,
  )
})

test("simulateProductProfitability: sin cuotas habilitadas, MP 1 pago (8%) es el PEOR escenario pese a tener MENOR tasa nominal que transferencia (10%)", () => {
  const result = simulateProductProfitability({
    price: 29_900,
    cost: 15_000,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)
  assert.equal(result!.worstCase.id, "mp_unico")

  const transferencia = result!.scenarios.find((scenario) => scenario.id === "transferencia")
  const mpUnico = result!.scenarios.find((scenario) => scenario.id === "mp_unico")
  assert.ok(transferencia!.marginPercent > mpUnico!.marginPercent)
})

test("CASO D: con cuotas habilitadas, el 'peor escenario' SIGUE siendo de base contado (mp_unico) -- las modalidades financiadas nunca compiten por ese título", () => {
  const result = simulateProductProfitability({
    price: 29_900,
    cost: 15_000,
    eligibleInstallmentCounts: [2, 3, 6],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)
  assert.equal(result!.worstCase.id, "mp_unico")
  assert.equal(result!.worstCase.priceBasis, "cash")
})

test("CASO E: la ganancia en PESOS de la cuota máxima es idéntica a la de contado (por construcción del gross-up); en cuotas por debajo del máximo es MAYOR -- margen extra intencional, nunca un error", () => {
  const price = 29_900 // contado
  const cost = 15_000
  const result = simulateProductProfitability({
    price,
    cost,
    eligibleInstallmentCounts: [2, 3, 6],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)

  const mpUnico = result!.scenarios.find((scenario) => scenario.id === "mp_unico")!
  const mp2 = result!.scenarios.find((scenario) => scenario.id === "mp_2")!
  const mp3 = result!.scenarios.find((scenario) => scenario.id === "mp_3")!
  const mp6 = result!.scenarios.find((scenario) => scenario.id === "mp_6")!

  // mp_6 usa el precio financiado (mayor al contado) y la tasa de la cuota
  // MÁXIMA -- por construcción, netAmount = financedPrice*(1-feeRate6) ==
  // price (contado, sin ninguna comisión) exacto, así que su ganancia en
  // pesos coincide con "precio de contado - costo" (no con mp_unico, que
  // tiene su PROPIA comisión de 8% aunque sea pago único). El financiado se
  // redondea HACIA ARRIBA al múltiplo de 6 (getFinancedPriceDivisor), así
  // que la ganancia nunca queda por debajo y la excede en menos de $6.
  assert.ok(mp6.profitAmount >= price - cost - 1e-6)
  assert.ok(mp6.profitAmount - (price - cost) < 6)
  assert.ok(mp6.profitAmount > mpUnico.profitAmount)
  // Pero mp_2 y mp_3 usan la MISMA base financiada (financedPrice de la
  // cuota 6) con una tasa REAL menor (18%/21% vs 31%) -- más ganancia en
  // pesos que contado sin comisión, el margen adicional intencional de la
  // regla 5.
  assert.ok(mp2.profitAmount > mpUnico.profitAmount)
  assert.ok(mp3.profitAmount > mpUnico.profitAmount)
  assert.ok(mp2.profitAmount > mp3.profitAmount)
  assert.ok(mp3.profitAmount > mp6.profitAmount)
  // Los tres comparten el mismo precio financiado (el total nunca cambia
  // según la cuota elegida).
  assert.equal(mp2.price, mp3.price)
  assert.equal(mp3.price, mp6.price)
  assert.ok(mp6.price > price)
  // El margen % de las modalidades financiadas es MENOR al de contado (se
  // divide por un ingreso mayor) -- no es peor caso, es aritmética distinta.
  assert.ok(mp6.marginPercent < calculateMarginFromPrice(price, cost, 0).marginPercent)
})

test("simulateProductProfitability: producto con una sola modalidad (2 cuotas) -- el peor escenario sigue siendo de base contado, nunca la cuota", () => {
  const result = simulateProductProfitability({
    price: 29_900,
    cost: 15_000,
    eligibleInstallmentCounts: [2],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)
  assert.equal(result!.worstCase.id, "mp_unico")
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
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)
  for (const scenario of result!.scenarios) {
    assert.ok(scenario.marginPercent < 0)
  }
})

test("calculateTargetMarginPrice: precio de CONTADO que garantiza el margen objetivo en transferencia y MP 1 pago (las únicas dos modalidades comparables en margen %)", () => {
  const result = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [2, 3, 6],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)
  assert.equal(result!.worstCaseScenario.id, "mp_unico")
  // Matemático: 15000 / (1 - 0.08 - 0.40) = 15000 / 0.52 = 28846.15... -> comercial $28.900.
  assert.equal(result!.commercialPrice, 28_900)
  assert.ok(result!.resultingMarginPercent >= 40)
  assert.ok(result!.resultingMarginPercent < 41)
})

test("CASO F: el precio de contado por margen objetivo YA NO depende de la configuración de cuotas -- las modalidades financiadas quedaron afuera de la resolución (simplificación deliberada del nuevo modelo)", () => {
  const withoutInstallments = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  const withThreeInstallments = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [3],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  const withAllInstallments = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [2, 3, 6],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })

  assert.ok(withoutInstallments && withThreeInstallments && withAllInstallments)
  assert.equal(withoutInstallments!.commercialPrice, withThreeInstallments!.commercialPrice)
  assert.equal(withThreeInstallments!.commercialPrice, withAllInstallments!.commercialPrice)
  assert.equal(withoutInstallments!.worstCaseScenario.id, "mp_unico")
})

test("calculateTargetMarginPrice: margen 0% como objetivo es válido", () => {
  const result = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 0,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)
  assert.ok(result!.resultingMarginPercent >= 0)
})

test("calculateTargetMarginPrice: costo inválido o margen objetivo inalcanzable devuelven null", () => {
  assert.equal(
    calculateTargetMarginPrice({
      cost: 0,
      targetMarginPercent: 40,
      eligibleInstallmentCounts: [],
      config: REAL_CONFIG,
      transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
    }),
    null,
  )
  assert.equal(
    calculateTargetMarginPrice({
      cost: 15_000,
      targetMarginPercent: 95,
      eligibleInstallmentCounts: [2, 3, 6],
      config: REAL_CONFIG,
      transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
    }),
    null,
  )
})

test("calculateTargetMarginPrice: SIN CUOTAS, el peor escenario real es MP 1 pago, no transferencia -- elegir por tasa nominal rompía la garantía de margen", () => {
  const cost = 15_000
  const targetMarginPercent = 40

  const result = calculateTargetMarginPrice({
    cost,
    targetMarginPercent,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)
  assert.equal(result!.worstCaseScenario.id, "mp_unico")

  const simulation = simulateProductProfitability({
    price: result!.commercialPrice,
    cost,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(simulation)
  for (const scenario of simulation!.scenarios) {
    assert.ok(
      scenario.marginPercent >= targetMarginPercent - 0.01,
      `${scenario.id} quedó en ${scenario.marginPercent}%, por debajo del 40% objetivo`,
    )
  }

  const transferenciaOnlyPrice = calculatePriceFromTargetMargin(
    cost,
    targetMarginPercent,
    10,
    "discount",
  )
  assert.ok(transferenciaOnlyPrice)
  const { marginPercent: mpUnicoMarginAtOldPrice } = calculateMarginFromPrice(
    transferenciaOnlyPrice!,
    cost,
    8,
    "fee",
  )
  assert.ok(mpUnicoMarginAtOldPrice < targetMarginPercent)
})

test("cambiar baseProcessingPercent/ivaPercent (afectan mp_unico) SÍ cambia el precio de contado calculado", () => {
  const cheaperBaseConfig: InstallmentsFinancingConfig = {
    ...REAL_CONFIG,
    baseProcessingPercent: 2,
  }

  const withRealConfig = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [6],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  const withCheaperConfig = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [6],
    config: cheaperBaseConfig,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })

  assert.ok(withRealConfig && withCheaperConfig)
  assert.notEqual(withRealConfig!.commercialPrice, withCheaperConfig!.commercialPrice)
  assert.ok(withCheaperConfig!.commercialPrice < withRealConfig!.commercialPrice)
})

test("cambiar sólo surchargePercentByCount (no afecta mp_unico/transferencia) NO cambia el precio de contado -- ese costo sólo se usa para derivar el financiado, no para fijar el contado", () => {
  const cheaperInstallmentsConfig: InstallmentsFinancingConfig = {
    ...REAL_CONFIG,
    surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 5 },
  }

  const withRealConfig = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [6],
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  const withCheaperInstallments = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [6],
    config: cheaperInstallmentsConfig,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })

  assert.ok(withRealConfig && withCheaperInstallments)
  assert.equal(withRealConfig!.commercialPrice, withCheaperInstallments!.commercialPrice)
})

test("cambiar transferDiscountPercent (site_settings.pricing) cambia el precio calculado cuando transferencia es el escenario que ata el precio", () => {
  const result10 = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 5,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
    transferDiscountPercent: 10,
  })
  const result30 = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 5,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
    transferDiscountPercent: 30,
  })

  assert.ok(result10 && result30)
  // A mayor % de descuento por transferencia, mayor precio de contado hace
  // falta para sostener el mismo margen objetivo en ese escenario -- y
  // transferencia es la que ata el precio en ambos casos (10% ya supera a
  // MP 1 pago con un margen objetivo bajo).
  assert.equal(result10!.worstCaseScenario.id, "transferencia")
  assert.equal(result30!.worstCaseScenario.id, "transferencia")
  assert.ok(result30!.commercialPrice > result10!.commercialPrice)
})
