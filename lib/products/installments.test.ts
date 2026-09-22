import assert from "node:assert/strict"
import test from "node:test"

import {
  getCartInstallmentEligibility,
  getEffectiveInstallmentPercent,
  getEligibleInstallmentCounts,
  getSinglePaymentEffectivePercent,
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

// Este archivo sólo cubre elegibilidad y el % interno de costo de MP -- las
// fórmulas de precio (contado/transferencia/financiado/CFTEA) viven en
// lib/pricing/financed-pricing.test.ts, el módulo canónico que las reemplaza.

test("el % efectivo se deriva de costo base + costo por cuotas + IVA, nunca de una constante -- SOLO uso interno (insumo del precio financiado y de rentabilidad/precio objetivo en Admin)", () => {
  // base 6.42 + adicional -> con IVA (x1.21) -> redondeo hacia arriba al entero
  assert.equal(getEffectiveInstallmentPercent(2, REAL_CONFIG), 18) // 14.21 * 1.21 = 17.1941
  assert.equal(getEffectiveInstallmentPercent(3, REAL_CONFIG), 21) // 16.91 * 1.21 = 20.4611
  assert.equal(getEffectiveInstallmentPercent(6, REAL_CONFIG), 31) // 25.11 * 1.21 = 30.3831
})

test("getSinglePaymentEffectivePercent: costo de MP en pago único, sin recargo por cuotas", () => {
  // Sólo baseProcessingPercent + IVA, sin surchargePercentByCount -> 6.42 * 1.21 = 7.7682 -> 8%.
  assert.equal(getSinglePaymentEffectivePercent(REAL_CONFIG), 8)
  // Siempre <= la de cualquier cantidad de cuotas (el recargo por cuotas nunca es negativo).
  assert.ok(getSinglePaymentEffectivePercent(REAL_CONFIG) <= getEffectiveInstallmentPercent(2, REAL_CONFIG))
})

test("cambiar cualquiera de los 3 ingredientes recalcula el % efectivo sin tocar código", () => {
  const higherIva: InstallmentsFinancingConfig = { ...REAL_CONFIG, ivaPercent: 25 }
  assert.equal(getEffectiveInstallmentPercent(3, higherIva), 22) // 16.91 * 1.25 = 21.1375

  const higherBase: InstallmentsFinancingConfig = { ...REAL_CONFIG, baseProcessingPercent: 8 }
  assert.equal(getEffectiveInstallmentPercent(3, higherBase), 23) // 18.49 * 1.21 = 22.3729
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

test("CASO H: carrito con máximo 6 + máximo 3 -- la modalidad ofrecida sólo se habilita si TODOS los productos la permiten (regla AND), el carrito queda en máximo 3", () => {
  const productoMax6 = noFinancing({ cuotas_2_habilitadas: true, cuotas_3_habilitadas: true, cuotas_6_habilitadas: true })
  const productoMax3 = noFinancing({ cuotas_3_habilitadas: true })
  const productoSinCuotas = noFinancing()

  // A permite 3/6, B permite 3, C no permite nada -> no se ofrece financiación del carrito.
  assert.deepEqual(getCartInstallmentEligibility([productoMax6, productoMax3, productoSinCuotas]), [])

  // A permite 2/3/6, B permite sólo 3 -> el carrito queda en máximo 3, nunca 6.
  const eligible = getCartInstallmentEligibility([productoMax6, productoMax3])
  assert.deepEqual(eligible, [3])
  assert.equal(eligible.includes(6), false)
  assert.equal(Math.max(...eligible), 3)
})

test("carrito vacío no ofrece ninguna modalidad", () => {
  assert.deepEqual(getCartInstallmentEligibility([]), [])
})
