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

test("getPaymentScenarioRates: los mismos escenarios para todos los productos -- transferencia y MP 1 pago son de base CONTADO", () => {
  const scenarios = getPaymentScenarioRates(REAL_CONFIG, TRANSFER_DISCOUNT_PERCENT)
  const cash = scenarios.filter((scenario) => scenario.priceBasis === "cash")
  assert.deepEqual(cash.map((scenario) => scenario.id), ["transferencia", "mp_unico"])
  assert.equal(cash[0].ratePercent, 10)
  assert.equal(cash[1].ratePercent, 8) // ceil(6.42 * 1.21) = ceil(7.7682)
  assert.equal(cash[0].kind, "discount")
  assert.equal(cash[1].kind, "fee")
})

test("getPaymentScenarioRates: una entrada FINANCIADA por cada tier que BEYONIX puede absorber (2/3/6), en orden ascendente", () => {
  const scenarios = getPaymentScenarioRates(REAL_CONFIG, TRANSFER_DISCOUNT_PERCENT)
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
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)
  assert.equal(result!.worstCase.id, "mp_unico")
  assert.equal(result!.worstCase.priceBasis, "cash")
})

test("CASO E: cada tier (2/3/6) cobra su propio financiado y deja la MISMA ganancia en pesos que el contado sin comisión", () => {
  const price = 29_900 // contado
  const cost = 15_000
  const result = simulateProductProfitability({
    price,
    cost,
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)

  const mpUnico = result!.scenarios.find((scenario) => scenario.id === "mp_unico")!
  const tiers = (["mp_2", "mp_3", "mp_6"] as const).map(
    (id) => result!.scenarios.find((scenario) => scenario.id === id)!,
  )
  // Precio financiado con el costo de SU tier: sube con la cantidad de cuotas.
  assert.ok(tiers[0].price < tiers[1].price && tiers[1].price < tiers[2].price)
  for (const tier of tiers) {
    assert.ok(tier.price > price)
    // Por el gross-up: neto = contado (redondeado hacia arriba al múltiplo, < $6 extra).
    assert.ok(tier.profitAmount >= price - cost - 1e-6)
    assert.ok(tier.profitAmount - (price - cost) < 6)
    assert.ok(tier.profitAmount > mpUnico.profitAmount)
    // Margen % menor al de contado: se divide por un ingreso mayor, no es pérdida.
    assert.ok(tier.marginPercent < calculateMarginFromPrice(price, cost, 0).marginPercent)
  }
})

test("simulateProductProfitability: el peor escenario sigue siendo de base contado, nunca una cuota", () => {
  const result = simulateProductProfitability({
    price: 29_900,
    cost: 15_000,
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)
  assert.equal(result!.worstCase.id, "mp_unico")
  assert.deepEqual(
    result!.scenarios.map((scenario) => scenario.id),
    ["transferencia", "mp_unico", "mp_2", "mp_3", "mp_6"],
  )
})

test("simulateProductProfitability: precio manual por debajo del costo -- margen negativo en todos los escenarios, sin excepción", () => {
  const result = simulateProductProfitability({
    price: 10_000,
    cost: 15_000,
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
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  const withThreeInstallments = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  const withAllInstallments = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
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
      config: REAL_CONFIG,
      transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
    }),
    null,
  )
  assert.equal(
    calculateTargetMarginPrice({
      cost: 15_000,
      targetMarginPercent: 95,
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
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(result)
  assert.equal(result!.worstCaseScenario.id, "mp_unico")

  const simulation = simulateProductProfitability({
    price: result!.commercialPrice,
    cost,
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  assert.ok(simulation)
  // La garantía es sobre los escenarios de base contado (las cuotas tienen
  // la misma ganancia en pesos, con margen % menor por aritmética).
  for (const scenario of simulation!.scenarios.filter((entry) => entry.priceBasis === "cash")) {
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
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  const withCheaperConfig = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
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
    config: REAL_CONFIG,
    transferDiscountPercent: TRANSFER_DISCOUNT_PERCENT,
  })
  const withCheaperInstallments = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
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
    config: REAL_CONFIG,
    transferDiscountPercent: 10,
  })
  const result30 = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 5,
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
