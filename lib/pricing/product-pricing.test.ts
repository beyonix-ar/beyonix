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

test("calculateMarginFromPrice (fee, ej. Mercado Pago): la tasa resta ganancia pero el margen se calcula sobre el precio público completo", () => {
  // El cliente paga $20.000 igual; Mercado Pago se queda con 10% al cobrar.
  // Ganancia = 20.000*0.9 - 15.000 = 3.000. Margen = 3.000 / 20.000 (precio
  // público, que es lo que el cliente realmente pagó).
  const { profitAmount, marginPercent } = calculateMarginFromPrice(20_000, 15_000, 10, "fee")
  assert.equal(profitAmount, 3_000)
  assert.equal(marginPercent, 15)
})

test("calculateMarginFromPrice (discount, ej. Transferencia): el margen se calcula sobre lo que el cliente REALMENTE pagó, no sobre el precio público", () => {
  // El cliente paga $16.000 (20.000 con 20% de descuento), no $20.000.
  // Ganancia = 16.000 - 8.000 = 8.000. Margen = 8.000 / 16.000 (el ingreso
  // real de la operación), no 8.000 / 20.000.
  const { profitAmount, marginPercent } = calculateMarginFromPrice(20_000, 8_000, 20, "discount")
  assert.equal(profitAmount, 8_000)
  assert.equal(marginPercent, 50)
})

test("AUDITORÍA: usar el precio público como base para Transferencia (como se hacía antes) infla/exprime el margen mostrado", () => {
  // Mismo precio, mismo costo, misma tasa nominal -- sólo cambia si esa tasa
  // es un descuento al cliente (revenue baja) o una comisión que absorbe
  // BEYONIX (revenue no cambia). El resultado NO puede ser el mismo margen.
  const asFee = calculateMarginFromPrice(20_000, 8_000, 20, "fee")
  const asDiscount = calculateMarginFromPrice(20_000, 8_000, 20, "discount")
  assert.equal(asFee.profitAmount, asDiscount.profitAmount) // la ganancia en pesos es idéntica...
  assert.notEqual(asFee.marginPercent, asDiscount.marginPercent) // ...pero el margen NO, porque la base es distinta
  assert.equal(asFee.marginPercent, 40) // 8000 / 20000
  assert.equal(asDiscount.marginPercent, 50) // 8000 / 16000
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

test("calculatePriceFromTargetMargin (discount): despeja sobre el neto que paga el cliente, no sobre el precio público", () => {
  const price = calculatePriceFromTargetMargin(8_000, 50, 20, "discount")
  // precio = costo / ((1-margen)*(1-tasa)) = 8000 / (0.5*0.8) = 20000
  assert.equal(price, 20_000)

  const { marginPercent } = calculateMarginFromPrice(price!, 8_000, 20, "discount")
  assert.equal(marginPercent, 50)
})

test("AUDITORÍA: la misma tasa nominal exige precios distintos según sea descuento o comisión -- por eso no alcanza con comparar tasas para elegir el peor escenario", () => {
  const asFeePrice = calculatePriceFromTargetMargin(8_000, 50, 20, "fee")
  const asDiscountPrice = calculatePriceFromTargetMargin(8_000, 50, 20, "discount")
  assert.equal(asFeePrice, 8_000 / 0.3) // 1 - 0.20 - 0.50
  assert.equal(asDiscountPrice, 20_000)
  assert.ok(asFeePrice! > asDiscountPrice!)
})

test("getPaymentScenarioRates: sin cuotas habilitadas, sólo transferencia y MP 1 pago", () => {
  const scenarios = getPaymentScenarioRates([], REAL_CONFIG)
  assert.deepEqual(
    scenarios.map((scenario) => scenario.id),
    ["transferencia", "mp_unico"],
  )
  assert.equal(scenarios[0].ratePercent, 10)
  assert.equal(scenarios[1].ratePercent, 8) // ceil(6.42 * 1.21) = ceil(7.7682)
  assert.equal(scenarios[0].kind, "discount") // transferencia: reduce lo que paga el cliente
  assert.equal(scenarios[1].kind, "fee") // Mercado Pago: el cliente paga el precio público entero
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
  assert.deepEqual(
    scenarios.map((scenario) => scenario.kind),
    ["discount", "fee", "fee", "fee", "fee"],
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

test("simulateProductProfitability: sin cuotas habilitadas, MP 1 pago (8%) es el PEOR escenario pese a tener MENOR tasa nominal que transferencia (10%)", () => {
  // AUDITORÍA: antes de corregir la base del margen, este test esperaba
  // "transferencia" acá -- pero eso era un artefacto de dividir siempre por
  // el precio público. Transferencia reduce el ingreso real de la operación
  // (revenue = precio*0.9), así que su margen correcto (ganancia/revenue) es
  // MAYOR al que mostraba antes (ganancia/precio). MP 1 pago no le reduce el
  // ingreso al cliente (paga el precio público entero), así que su margen se
  // sigue calculando sobre el precio público -- y con la tasa nominal más
  // baja (8% vs 10%) termina siendo, en los hechos, el escenario más ajustado.
  const result = simulateProductProfitability({
    price: 29_900,
    cost: 15_000,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
  })
  assert.ok(result)
  assert.equal(result!.worstCase.id, "mp_unico")

  const transferencia = result!.scenarios.find((scenario) => scenario.id === "transferencia")
  const mpUnico = result!.scenarios.find((scenario) => scenario.id === "mp_unico")
  assert.ok(transferencia!.marginPercent > mpUnico!.marginPercent)
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

test("CASO F (informe de precio único): sólo 3 cuotas máximo habilitadas -- el precio objetivo usa el costo de MP3 como peor escenario, no MP6 (no habilitado)", () => {
  const result = calculateTargetMarginPrice({
    cost: 15_000,
    targetMarginPercent: 40,
    eligibleInstallmentCounts: [3],
    config: REAL_CONFIG,
  })
  assert.ok(result)
  assert.equal(result!.worstCaseScenario.id, "mp_3")
  // Matemático: 15000 / (1 - 0.21 - 0.40) = 15000 / 0.39 = 38461.53... -> comercial $38.900.
  assert.equal(result!.commercialPrice, 38_900)
  assert.ok(result!.resultingMarginPercent >= 40)

  // Ese mismo precio único es el que se cobra sin importar la cuota elegida
  // -- 1 pago, 2 (no habilitado acá) o 3 cuotas, siempre $38.900.
  const simulation = simulateProductProfitability({
    price: result!.commercialPrice,
    cost: 15_000,
    eligibleInstallmentCounts: [3],
    config: REAL_CONFIG,
  })
  assert.ok(simulation)
  assert.equal(simulation!.scenarios.length, 3) // transferencia + mp_unico + mp_3, nunca mp_6
  assert.ok(simulation!.scenarios.every((scenario) => scenario.marginPercent >= 40 - 0.5))
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

test("calculateTargetMarginPrice: SIN CUOTAS, el peor escenario real es MP 1 pago, no transferencia -- elegir por tasa nominal rompía la garantía de margen", () => {
  // BUG HISTÓRICO (server y cliente calculaban igual): al elegir el "peor
  // escenario" comparando sólo `ratePercent`, transferencia (10%) le ganaba
  // a MP 1 pago (8%) y el precio se resolvía SOLO para transferencia. Ese
  // precio no garantizaba el margen objetivo en MP 1 pago, que es el
  // escenario realmente más ajustado (ver test de simulateProductProfitability
  // arriba). Esta prueba fija el comportamiento correcto: el precio se
  // resuelve para el escenario que de verdad exige más.
  const cost = 15_000
  const targetMarginPercent = 40

  const result = calculateTargetMarginPrice({
    cost,
    targetMarginPercent,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
  })
  assert.ok(result)
  assert.equal(result!.worstCaseScenario.id, "mp_unico")

  // El precio final debe garantizar >= 40% de margen en TODOS los escenarios
  // habilitados, no sólo en el que fijó el precio.
  const simulation = simulateProductProfitability({
    price: result!.commercialPrice,
    cost,
    eligibleInstallmentCounts: [],
    config: REAL_CONFIG,
  })
  assert.ok(simulation)
  for (const scenario of simulation!.scenarios) {
    assert.ok(
      scenario.marginPercent >= targetMarginPercent - 0.01,
      `${scenario.id} quedó en ${scenario.marginPercent}%, por debajo del 40% objetivo`,
    )
  }

  // Regresión explícita del bug: el precio que hubiera salido de resolver
  // SÓLO transferencia (el que elegía el código viejo) deja a MP 1 pago por
  // debajo del margen objetivo.
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
