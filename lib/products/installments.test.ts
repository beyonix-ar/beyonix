import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateFinancedTotal,
  calculateInstallmentPlan,
  getCartInstallmentEligibility,
  getEffectiveInstallmentPercent,
  getEligibleInstallmentCounts,
  getInstallmentPlanLabels,
  roundUpToCommercialHundred,
  type InstallmentsFinancingConfig,
} from "./installments.ts"

const REAL_CONFIG: InstallmentsFinancingConfig = {
  baseProcessingPercent: 6.42,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}

function noFinancing(overrides: Partial<Record<"cuotas_2_habilitadas" | "cuotas_3_habilitadas" | "cuotas_6_habilitadas", boolean>> = {}) {
  return {
    cuotas_2_habilitadas: false,
    cuotas_3_habilitadas: false,
    cuotas_6_habilitadas: false,
    ...overrides,
  }
}

test("el % efectivo se deriva de costo base + costo por cuotas + IVA, nunca de una constante", () => {
  // base 6.42 + adicional -> con IVA (x1.21) -> redondeo hacia arriba al entero
  assert.equal(getEffectiveInstallmentPercent(2, REAL_CONFIG), 18) // 14.21 * 1.21 = 17.1941
  assert.equal(getEffectiveInstallmentPercent(3, REAL_CONFIG), 21) // 16.91 * 1.21 = 20.4611
  assert.equal(getEffectiveInstallmentPercent(6, REAL_CONFIG), 31) // 25.11 * 1.21 = 30.3831
})

test("cambiar cualquiera de los 3 ingredientes recalcula el % efectivo sin tocar código", () => {
  const higherIva: InstallmentsFinancingConfig = { ...REAL_CONFIG, ivaPercent: 25 }
  assert.equal(getEffectiveInstallmentPercent(3, higherIva), 22) // 16.91 * 1.25 = 21.1375

  const higherBase: InstallmentsFinancingConfig = { ...REAL_CONFIG, baseProcessingPercent: 8 }
  assert.equal(getEffectiveInstallmentPercent(3, higherBase), 23) // 18.49 * 1.21 = 22.3729
})

test("roundUpToCommercialHundred nunca redondea hacia abajo", () => {
  assert.equal(roundUpToCommercialHundred(28089.89), 28100)
  assert.equal(roundUpToCommercialHundred(15432.1), 15500)
})

test("roundUpToCommercialHundred: límites exactos de redondeo", () => {
  // Múltiplo exacto: no debe subir al siguiente.
  assert.equal(roundUpToCommercialHundred(28100), 28100)
  assert.equal(roundUpToCommercialHundred(100), 100)
  assert.equal(roundUpToCommercialHundred(0), 0)
  // Un centavo por encima de un múltiplo exacto sí debe subir.
  assert.equal(roundUpToCommercialHundred(28100.01), 28200)
  // Un centavo por debajo también redondea al múltiplo de arriba (nunca abajo).
  assert.equal(roundUpToCommercialHundred(28099.99), 28100)
  // Arrastre de punto flotante sobre un múltiplo exacto no debe dispararlo.
  assert.equal(roundUpToCommercialHundred(28100.000000003), 28100)
  assert.equal(roundUpToCommercialHundred(15500 - 1e-9), 15500)
})

test("calculateFinancedTotal compensa el porcentaje, no lo suma ingenuamente", () => {
  const financed = calculateFinancedTotal(75_000, 11)
  // 75000 / 0.89 != 75000 * 1.11
  assert.ok(Math.abs(financed - 84_269.66) < 0.01)
  assert.notEqual(financed, 75_000 * 1.11)
})

test("plan de 3 cuotas para un producto de $75.000 con los costos reales de MP", () => {
  const plan = calculateInstallmentPlan(75_000, 3, REAL_CONFIG)
  assert.ok(plan)
  assert.equal(plan!.percent, 21)
  // 75000 / 0.79 = 94936.708... / 3 = 31645.57 -> redondeado a $100 hacia arriba
  assert.equal(plan!.installmentAmount, 31_700)
  assert.equal(plan!.totalFinanced, 31_700 * 3)
})

test("plan de 6 cuotas para un producto de $75.000 con los costos reales de MP", () => {
  const plan = calculateInstallmentPlan(75_000, 6, REAL_CONFIG)
  assert.ok(plan)
  assert.equal(plan!.percent, 31)
  // 75000 / 0.69 = 108695.65... / 6 = 18115.94 -> redondeado a $100 hacia arriba
  assert.equal(plan!.installmentAmount, 18_200)
  assert.equal(plan!.totalFinanced, 18_200 * 6)
})

test("plan de 2 cuotas para un producto de $75.000 con los costos reales de MP", () => {
  const plan = calculateInstallmentPlan(75_000, 2, REAL_CONFIG)
  assert.ok(plan)
  assert.equal(plan!.percent, 18)
  // 75000 / 0.82 = 91463.41... / 2 = 45731.71 -> redondeado a $100 hacia arriba
  assert.equal(plan!.installmentAmount, 45_800)
  assert.equal(plan!.totalFinanced, 45_800 * 2)
})

test("un monto base inválido o cero no genera plan", () => {
  assert.equal(calculateInstallmentPlan(0, 3, REAL_CONFIG), null)
  assert.equal(calculateInstallmentPlan(-100, 3, REAL_CONFIG), null)
  assert.equal(calculateInstallmentPlan(Number.NaN, 3, REAL_CONFIG), null)
})

test("elegibilidad por producto: ninguna, una, dos y las tres modalidades", () => {
  assert.deepEqual(getEligibleInstallmentCounts(noFinancing()), [])
  assert.deepEqual(getEligibleInstallmentCounts(noFinancing({ cuotas_3_habilitadas: true })), [3])
  assert.deepEqual(
    getEligibleInstallmentCounts(noFinancing({ cuotas_2_habilitadas: true, cuotas_6_habilitadas: true })),
    [2, 6],
  )
  assert.deepEqual(
    getEligibleInstallmentCounts(
      noFinancing({ cuotas_2_habilitadas: true, cuotas_3_habilitadas: true, cuotas_6_habilitadas: true }),
    ),
    [2, 3, 6],
  )
})

test("carrito: la modalidad sólo se ofrece si TODOS los productos la permiten (regla AND)", () => {
  const productoA = noFinancing({ cuotas_2_habilitadas: true, cuotas_3_habilitadas: true, cuotas_6_habilitadas: true })
  const productoB = noFinancing({ cuotas_3_habilitadas: true })
  const productoC = noFinancing()

  // A permite 3/6, B permite 3, C no permite nada -> no se ofrece financiación del carrito.
  assert.deepEqual(getCartInstallmentEligibility([productoA, productoB, productoC]), [])

  // A permite 3/6, B permite 3 -> sólo 3 cuotas disponible.
  assert.deepEqual(getCartInstallmentEligibility([productoA, productoB]), [3])
})

test("carrito vacío no ofrece ninguna modalidad", () => {
  assert.deepEqual(getCartInstallmentEligibility([]), [])
})

test("pedir 6 cuotas en un carrito que sólo admite 3 queda fuera de lo elegible (create-preference lo rechaza)", () => {
  const productoSolo3 = noFinancing({ cuotas_3_habilitadas: true })
  const eligible = getCartInstallmentEligibility([productoSolo3])

  assert.deepEqual(eligible, [3])
  assert.equal(eligible.includes(6), false)
})

test("producto sin ninguna cuota habilitada nunca genera un plan financiado", () => {
  const producto = noFinancing()
  assert.deepEqual(getEligibleInstallmentCounts(producto), [])
  // Ni siquiera pedirlo explícito a la función de cálculo debería usarse en
  // la práctica -- create-preference nunca llega a llamarla porque valida
  // elegibilidad antes -- pero si se llamara igual, el cálculo en sí no
  // sabe "prohibir": la prohibición vive en la capa de elegibilidad, que ya
  // devuelve [] acá.
})

test("envío efectivamente cobrado entra en la base financiable (no se financia sólo el producto)", () => {
  // $75.000 en productos + $10.000 de envío pagado -> base $85.000, tal
  // como arma create-preference (productsNet + shipping.shipping_cost_charged).
  const conEnvioPagado = calculateInstallmentPlan(85_000, 3, REAL_CONFIG)
  const sinEnvio = calculateInstallmentPlan(75_000, 3, REAL_CONFIG)

  assert.ok(conEnvioPagado)
  assert.ok(sinEnvio)
  assert.equal(conEnvioPagado!.installmentAmount, 35_900)
  assert.notEqual(conEnvioPagado!.installmentAmount, sinEnvio!.installmentAmount)
})

test("envío gratis (cliente paga $0) no agrega nada a la base financiable", () => {
  // Mismo resultado que sin envío: la base es productsNet + 0.
  const envioGratis = calculateInstallmentPlan(75_000 + 0, 3, REAL_CONFIG)
  const sinEnvio = calculateInstallmentPlan(75_000, 3, REAL_CONFIG)

  assert.deepEqual(envioGratis, sinEnvio)
})

test("las etiquetas de cara al cliente nunca mencionan porcentaje, comisión ni 'financiado'", () => {
  const producto = noFinancing({ cuotas_3_habilitadas: true, cuotas_6_habilitadas: true })
  const labels = getInstallmentPlanLabels(producto, 75_000, REAL_CONFIG)

  assert.deepEqual(labels, [
    "Hasta 3 cuotas sin interés de $31.700",
    "Hasta 6 cuotas sin interés de $18.200",
  ])
  for (const label of labels) {
    assert.doesNotMatch(label, /%|financiad|comisi[oó]n|recargo/i)
    // Checkout Pro fija "installments" como TOPE ofrecido, no como cantidad
    // obligatoria: el texto nunca puede prometer "N cuotas" a secas, porque
    // Mercado Pago puede terminar ofreciendo menos según el medio de pago.
    assert.match(label, /^Hasta \d+ cuotas sin interés de \$/)
  }
})

test("un producto sin cuotas habilitadas no genera ninguna etiqueta", () => {
  assert.deepEqual(getInstallmentPlanLabels(noFinancing(), 75_000, REAL_CONFIG), [])
})

test("la etiqueta usa el precio efectivamente mostrado, no un precio de producto fijo", () => {
  const producto = noFinancing({ cuotas_3_habilitadas: true })
  // Precio de una variante/condicionado distinto al del producto base.
  const labels = getInstallmentPlanLabels(producto, 50_000, REAL_CONFIG)
  assert.notDeepEqual(labels, getInstallmentPlanLabels(producto, 75_000, REAL_CONFIG))
})
