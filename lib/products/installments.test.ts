import assert from "node:assert/strict"
import test from "node:test"

import {
  getEffectiveInstallmentPercent,
  getSinglePaymentEffectivePercent,
  INSTALLMENT_COUNTS,
  MAX_INTEREST_FREE_INSTALLMENTS,
  type InstallmentsFinancingConfig,
} from "./installments.ts"

const REAL_CONFIG: InstallmentsFinancingConfig = {
  baseProcessingPercent: 6.42,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}

// Este archivo sólo cubre las cuotas posibles y el % interno de costo de MP -- las
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

test("la financiación no es una propiedad del producto: sólo 2, 3 y 6 cuotas, máximo comercial 6", () => {
  assert.deepEqual([...INSTALLMENT_COUNTS], [2, 3, 6])
  assert.equal(MAX_INTEREST_FREE_INSTALLMENTS, 6)
  assert.ok(!INSTALLMENT_COUNTS.some((count) => count > MAX_INTEREST_FREE_INSTALLMENTS), "nunca 9/12/18")
})
