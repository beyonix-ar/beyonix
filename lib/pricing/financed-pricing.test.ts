import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateCftea,
  calculateMonthlyFinancingRate,
  getCartFinancedTotal,
  getCashPrice,
  getFinancedFeeRate,
  getFinancedPriceDivisor,
  getFinancedPrice,
  getInstallmentAmount,
  getPriceWithoutNationalTaxes,
  getTransferPrice,
} from "./financed-pricing.ts"
import { INSTALLMENT_COUNTS, type InstallmentCount, type InstallmentsFinancingConfig } from "../products/installments.ts"

// Planes de un TIER (la cuota máxima que confirma Mercado Pago para el total):
// todas las cuotas <= tier dividen el MISMO financiado. La financiación ya no
// depende del producto.
function tierPlans(tier: InstallmentCount, cashPrice: number, config: InstallmentsFinancingConfig) {
  const financed = getFinancedPrice(cashPrice, tier, config)
  return financed == null
    ? []
    : INSTALLMENT_COUNTS.filter((count) => count <= tier).map((count) => ({ count, amount: getInstallmentAmount(financed, count)! }))
}

const REAL_CONFIG: InstallmentsFinancingConfig = {
  baseProcessingPercent: 6.42,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}


// CASO A: contado $100.000, transferencia 10% -> $90.000.
test("CASO A: getTransferPrice aplica el % configurado sobre el contado", () => {
  assert.equal(getTransferPrice(100_000, 10), 90_000)
  assert.equal(getTransferPrice(100_000, 0), 100_000)
})

test("getCashPrice: básicos", () => {
  assert.equal(getCashPrice({ precio: 50_000 }), 50_000)
  assert.equal(getCashPrice({ precio: -10 }), 0)
})

// CASO B: máximo 2 cuotas -> el financiado usa el fee de 2 cuotas (18% efectivo).
test("CASO B: getFinancedPrice usa la tasa efectiva de la cuota máxima habilitada", () => {
  assert.equal(getFinancedFeeRate(2, REAL_CONFIG), 0.18)
  const financedPrice = getFinancedPrice(100_000, 2, REAL_CONFIG)
  // 121951,22 -> hacia arriba al múltiplo de 2.
  assert.equal(financedPrice, 121_952)
  assert.ok(financedPrice! > 100_000)
})

test("sin tier confirmado no hay precio financiado", () => {
  assert.equal(getFinancedPrice(100_000, null, REAL_CONFIG), null)
})

// CASO C: máximo 3 -> 2 y 3 cuotas comparten el MISMO total financiado.
test("CASO C: con máximo 3 cuotas habilitado, 2 y 3 cuotas dividen el mismo precio financiado", () => {
  const cashPrice = 100_000
  const financedPrice = getFinancedPrice(cashPrice, 3, REAL_CONFIG)!
  const plans = tierPlans(3, cashPrice, REAL_CONFIG)

  assert.deepEqual(
    plans.map((plan) => plan.count),
    [2, 3],
  )
  for (const plan of plans) {
    assert.equal(plan.amount * plan.count, financedPrice)
  }
})

// CASO D: máximo 6 -> 2, 3 y 6 cuotas comparten el MISMO total financiado.
test("CASO D: con máximo 6 cuotas habilitado, 2, 3 y 6 cuotas dividen el mismo precio financiado", () => {
  const cashPrice = 100_000
  const financedPrice = getFinancedPrice(cashPrice, 6, REAL_CONFIG)!
  const plans = tierPlans(6, cashPrice, REAL_CONFIG)

  assert.deepEqual(
    plans.map((plan) => plan.count),
    [2, 3, 6],
  )
  for (const plan of plans) {
    assert.equal(plan.amount * plan.count, financedPrice)
  }
})

// CASO E: máximo 6 + cliente elige 2 -> el total financiado sigue siendo el
// de 6 cuotas, sólo cambia cuánto vale cada cuota informativa.
test("CASO E: elegir menos cuotas que el máximo sólo divide distinto -- el total financiado no cambia", () => {
  const cashPrice = 100_000
  const financedPrice = getFinancedPrice(cashPrice, 6, REAL_CONFIG)!
  const amount2 = getInstallmentAmount(financedPrice, 2)!
  const amount6 = getInstallmentAmount(financedPrice, 6)!

  assert.equal(amount2 * 2, financedPrice)
  assert.equal(amount6 * 6, financedPrice)
  // 2 cuotas valen bastante más cada una que 6 cuotas del MISMO total.
  assert.ok(amount2 > amount6 * 2)
})

// CASO F: cambiar el máximo habilitado recalcula automáticamente el
// financiado publicado -- nunca queda un valor persistido desactualizado.
test("CASO F: cambiar el máximo habilitado (3 -> 6) recalcula el financiado, sin estado persistido", () => {
  const cashPrice = 100_000
  const financedAt3 = getFinancedPrice(cashPrice, 3, REAL_CONFIG)
  const financedAt6 = getFinancedPrice(cashPrice, 6, REAL_CONFIG)

  assert.notEqual(financedAt3, financedAt6)
  assert.ok(financedAt6! > financedAt3!)
})

// CASO H: carrito con producto de máximo 6 + producto de máximo 3 -- el
// total financiado del carrito es la SUMA de los financiados individuales,
// nunca recalculado con la tasa del mínimo común (3).
test("CASO H: getCartFinancedTotal suma los financiados de cada línea con el MISMO tier (el del total)", () => {
  const total = getCartFinancedTotal(
    [
      { cashPrice: 100_000, quantity: 1 },
      { cashPrice: 50_000, quantity: 1 },
    ],
    6,
    REAL_CONFIG,
  )
  assert.equal(total, getFinancedPrice(100_000, 6, REAL_CONFIG)! + getFinancedPrice(50_000, 6, REAL_CONFIG)!)
  // Con tier 3 el total financiado es menor (costo de 3).
  assert.ok(
    getCartFinancedTotal([{ cashPrice: 100_000, quantity: 1 }, { cashPrice: 50_000, quantity: 1 }], 3, REAL_CONFIG) < total,
  )
})


test("cantidad > 1 multiplica el financiado por unidad", () => {
  const financedPerUnit = getFinancedPrice(100_000, 6, REAL_CONFIG)!
  const total = getCartFinancedTotal([{ cashPrice: 100_000, quantity: 2 }], 6, REAL_CONFIG)
  assert.equal(total, financedPerUnit * 2)
})

// CASO J (transferencia nunca financia) se cubre en lib/payments/transfer.test.ts
// -- ese módulo ni siquiera acepta un parámetro de cuotas.

// CASO K: "precio sin impuestos nacionales" usa la incidencia configurable.
test("CASO K: getPriceWithoutNationalTaxes usa la incidencia configurada, nunca 21% hardcodeado", () => {
  assert.equal(getPriceWithoutNationalTaxes(121_000, 21), 100_000)
  assert.equal(getPriceWithoutNationalTaxes(100_000, 0), 100_000)

  const at10 = getPriceWithoutNationalTaxes(110_000, 10)
  const at30 = getPriceWithoutNationalTaxes(110_000, 30)
  assert.notEqual(at10, at30)
  assert.ok(at30 < at10)
})

// CASO L: CFTEA -- el solver numérico reproduce el precio de contado al
// descontar las cuotas con la tasa mensual que devuelve.
test("CASO L: calculateCftea es internamente consistente -- la tasa mensual resuelta reproduce el contado al descontar las cuotas", () => {
  const cashPrice = 100_000
  const financedPrice = getFinancedPrice(cashPrice, 6, REAL_CONFIG)!
  const installmentAmount = getInstallmentAmount(financedPrice, 6)!

  const monthlyRate = calculateMonthlyFinancingRate(cashPrice, installmentAmount, 6)
  assert.ok(monthlyRate != null && monthlyRate > 0)

  let presentValue = 0
  for (let k = 1; k <= 6; k++) {
    presentValue += installmentAmount / Math.pow(1 + monthlyRate!, k)
  }
  assert.ok(Math.abs(presentValue - cashPrice) < 1)

  const cftea = calculateCftea(cashPrice, installmentAmount, 6)
  assert.ok(cftea != null && cftea > 0)
  assert.ok(Math.abs(Math.pow(1 + monthlyRate!, 12) - 1 - cftea! / 100) < 1e-9)
})

test("CASO L: a IGUAL cantidad de cuotas, un fee efectivo mayor produce un CFTEA mayor", () => {
  // A cantidad de cuotas fija, el CFTEA sube con el fee -- no se puede
  // comparar directamente entre cantidades de cuotas distintas: menos
  // cuotas implica devolver el recargo en menos tiempo, lo que por sí solo
  // ya sube la tasa anualizada incluso con un fee nominal menor (por eso acá
  // se fija `count` y sólo se varía el fee, aislando la variable real).
  const cashPrice = 100_000
  const cheaperConfig: InstallmentsFinancingConfig = {
    ...REAL_CONFIG,
    surchargePercentByCount: { ...REAL_CONFIG.surchargePercentByCount, 6: 5 },
  }
  const financedCheap = getFinancedPrice(cashPrice, 6, cheaperConfig)!
  const financedReal = getFinancedPrice(cashPrice, 6, REAL_CONFIG)!
  const cfteaCheap = calculateCftea(cashPrice, getInstallmentAmount(financedCheap, 6)!, 6)
  const cfteaReal = calculateCftea(cashPrice, getInstallmentAmount(financedReal, 6)!, 6)

  assert.ok(cfteaCheap != null && cfteaReal != null)
  assert.ok(financedReal > financedCheap)
  assert.ok(cfteaReal! > cfteaCheap!)
})

test("CASO L: menos cuotas para devolver un recargo similar implica un CFTEA anualizado MAYOR, no menor -- el CFTEA no es simplemente proporcional al fee nominal", () => {
  // Documenta explícitamente la propiedad no intuitiva verificada arriba:
  // con REAL_CONFIG, 2 cuotas (fee nominal 18%) da un CFTEA MAYOR que 6
  // cuotas (fee nominal 31%), porque el recargo de 2 cuotas se devuelve en
  // muchísimo menos tiempo. Confirma que calculateCftea pondera el plazo,
  // no sólo el monto del recargo.
  const cashPrice = 100_000
  const financedAt2 = getFinancedPrice(cashPrice, 2, REAL_CONFIG)!
  const financedAt6 = getFinancedPrice(cashPrice, 6, REAL_CONFIG)!
  const cftea2 = calculateCftea(cashPrice, getInstallmentAmount(financedAt2, 2)!, 2)
  const cftea6 = calculateCftea(cashPrice, getInstallmentAmount(financedAt6, 6)!, 6)

  assert.ok(cftea2 != null && cftea6 != null)
  assert.ok(cftea2! > cftea6!)
})

test("regla legal: nunca se muestra CFTEA en pago único (1 cuota) ni cuando no hay costo financiero real", () => {
  assert.equal(calculateCftea(100_000, 100_000, 1), null)
  // 6 cuotas que en total NO superan el contado (dato inválido/degenerado):
  // no hay costo financiero real que resolver.
  assert.equal(calculateCftea(100_000, 15_000, 6), null)
})

// CASO N: nunca se ajusta una cuota individual -- getInstallmentAmount es
// una división exacta del total canónico.
test("CASO N: getInstallmentAmount divide exacto, sin redondear ni ajustar cuotas", () => {
  assert.equal(getInstallmentAmount(63_018, 6), 10_503)
  assert.equal(getInstallmentAmount(63_018.06, 6), 10_503.01)
  assert.equal(getInstallmentAmount(63_018.06, 3), 21_006.02)
  assert.equal(getInstallmentAmount(63_018.06, 2), 31_509.03)
})

test("montos inválidos (0, negativo, NaN) no generan cuotas", () => {
  assert.equal(getInstallmentAmount(0, 3), null)
  assert.equal(getInstallmentAmount(-100, 3), null)
  assert.equal(getInstallmentAmount(Number.NaN, 3), null)
})


// CASO O: el total financiado es IDÉNTICO sin importar cuántas cuotas se
// elijan -- ni $1 de diferencia. Regla: redondeo hacia arriba al múltiplo
// común de las cuotas, nunca ajuste de cuotas individuales.
test("CASO O: getFinancedPriceDivisor es el mínimo común múltiplo de las cuotas <= máximo", () => {
  assert.equal(getFinancedPriceDivisor(2), 2)
  assert.equal(getFinancedPriceDivisor(3), 6)
  assert.equal(getFinancedPriceDivisor(6), 6)
})

test("CASO O (obligatorio): máximo 6 -> 2, 3 y 6 cuotas cierran EXACTO el mismo total financiado", () => {
  for (const cashPrice of [1, 999, 45_677, 51_673, 63_014, 100_000, 1_234_567]) {
    const financedTotal = getFinancedPrice(cashPrice, 6, REAL_CONFIG)!
    const installment2 = getInstallmentAmount(financedTotal, 2)!
    const installment3 = getInstallmentAmount(financedTotal, 3)!
    const installment6 = getInstallmentAmount(financedTotal, 6)!

    assert.ok(Number.isInteger(financedTotal))
    assert.equal(installment2 * 2, financedTotal)
    assert.equal(installment3 * 3, financedTotal)
    assert.equal(installment6 * 6, financedTotal)
    assert.equal(installment2 * 2, installment3 * 3)
    assert.equal(installment3 * 3, installment6 * 6)

    for (const plan of tierPlans(6, cashPrice, REAL_CONFIG)) {
      assert.equal(plan.amount * plan.count, financedTotal)
    }
  }
})

test("CASO O: el ajuste es HACIA ARRIBA y como máximo divisor-1 pesos sobre el gross-up", () => {
  for (const maxCount of [2, 3, 6] as const) {
    for (const cashPrice of [1, 12_345, 51_673, 100_000, 987_654]) {
      const grossUp = cashPrice / (1 - getFinancedFeeRate(maxCount, REAL_CONFIG))
      const financedTotal = getFinancedPrice(cashPrice, maxCount, REAL_CONFIG)!
      const divisor = getFinancedPriceDivisor(maxCount)

      assert.equal(financedTotal % divisor, 0)
      assert.ok(financedTotal >= grossUp)
      assert.ok(financedTotal - grossUp < divisor)
    }
  }
})

test("CASO O: máximo 3 -> 2 y 3 cuotas cierran exacto; máximo 2 -> divisible por 2", () => {
  for (const cashPrice of [7, 45_677, 100_001]) {
    const financedAt3 = getFinancedPrice(cashPrice, 3, REAL_CONFIG)!
    assert.equal(getInstallmentAmount(financedAt3, 2)! * 2, financedAt3)
    assert.equal(getInstallmentAmount(financedAt3, 3)! * 3, financedAt3)

    const financedAt2 = getFinancedPrice(cashPrice, 2, REAL_CONFIG)!
    assert.equal(getInstallmentAmount(financedAt2, 2)! * 2, financedAt2)
  }
})

test("CASO O: un gross-up que ya es múltiplo exacto no sube al múltiplo siguiente", () => {
  // fee 0 (config degenerada): el gross-up es el contado mismo.
  const zeroFee: InstallmentsFinancingConfig = {
    baseProcessingPercent: 0,
    ivaPercent: 0,
    surchargePercentByCount: { 2: 0, 3: 0, 6: 0 },
  }
  assert.equal(getFinancedPrice(63_018, 6, zeroFee), 63_018)
  assert.equal(getFinancedPrice(63_014, 6, zeroFee), 63_018)
})

test("CASO O: varias líneas y cantidades -- con el tier del total, cada cuota ofrecida cierra exacto", () => {
  const lines = [
    { cashPrice: 63_014, quantity: 3 },
    { cashPrice: 45_677, quantity: 2 },
    { cashPrice: 12_345, quantity: 1 },
  ]
  for (const tier of [2, 3, 6] as const) {
    const total = getCartFinancedTotal(lines, tier, REAL_CONFIG)
    for (const count of INSTALLMENT_COUNTS.filter((value) => value <= tier)) {
      assert.equal(getInstallmentAmount(total, count)! * count, total, `tier ${tier}, ${count} cuotas`)
    }
  }
})
