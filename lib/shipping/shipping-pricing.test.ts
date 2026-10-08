import assert from "node:assert/strict"
import test from "node:test"

import {
  buildShippingPriceBreakdown,
  compareParcelQuote,
  isConsistentShippingPriceBreakdown,
  markupCents,
  markupPercentToBasisPoints,
  roundShippingCentsToNearestTen,
  roundShippingToNearestTen,
  ShippingMarkupError,
} from "./shipping-pricing.ts"

/** Desglose en pesos, para leer los ejemplos como en el negocio. */
function pesos(providerAmount: number, percent: number | string) {
  const breakdown = buildShippingPriceBreakdown(providerAmount, markupPercentToBasisPoints(percent))
  assert.equal(
    breakdown.providerCents + breakdown.markupCents + breakdown.roundingCents,
    breakdown.logisticsCents,
    "tarifa + recargo + ajuste = precio logístico",
  )
  assert.equal(breakdown.logisticsCents % 1_000, 0, "entero terminado en 0, sin centavos")
  return {
    tarifa: breakdown.providerCents / 100,
    recargo: breakdown.markupCents / 100,
    ajuste: breakdown.roundingCents / 100,
    precioLogistico: breakdown.logisticsCents / 100,
  }
}

test("Andreani $10.000: 0% → $10.000, 5% → $10.500, 5,5% → $10.550", () => {
  assert.deepEqual(pesos(10_000, 0), { tarifa: 10_000, recargo: 0, ajuste: 0, precioLogistico: 10_000 })
  assert.deepEqual(pesos(10_000, 5), { tarifa: 10_000, recargo: 500, ajuste: 0, precioLogistico: 10_500 })
  assert.deepEqual(pesos(10_000, "5,5"), { tarifa: 10_000, recargo: 550, ajuste: 0, precioLogistico: 10_550 })
})

test("Andreani $9.943: 0% → $9.940; 5% → recargo exacto $497,15, subtotal $10.440,15 → $10.440", () => {
  assert.deepEqual(pesos(9_943, 0), { tarifa: 9_943, recargo: 0, ajuste: -3, precioLogistico: 9_940 })
  assert.deepEqual(pesos(9_943, 5), { tarifa: 9_943, recargo: 497.15, ajuste: -0.15, precioLogistico: 10_440 })
})

test("Andreani $12.347 al 3%: recargo $370,41, subtotal $12.717,41 → $12.720 (redondeo sólo al final)", () => {
  assert.deepEqual(pesos(12_347, 3), { tarifa: 12_347, recargo: 370.41, ajuste: 2.59, precioLogistico: 12_720 })
})

test("nunca redondea a centenas ni a miles (regla vieja de miles eliminada)", () => {
  assert.equal(pesos(13_299, 0).precioLogistico, 13_300)
  assert.equal(pesos(13_854.56, 0).precioLogistico, 13_850)
  assert.equal(pesos(10_001, 5).precioLogistico, 10_500)
})

test("recargo con fracciones de centavo: el subtotal se redondea una sola vez", () => {
  // 10.001,11 × 5,55% = 555,061605 → recargo informado $555,06; total exacto 10.556,171605 → $10.560
  assert.deepEqual(pesos(10_001.11, "5,55"), { tarifa: 10_001.11, recargo: 555.06, ajuste: 3.83, precioLogistico: 10_560 })
})

test("$10.001 al 5% da siempre el mismo resultado (enteros, mitad hacia arriba)", () => {
  assert.equal(markupCents(1_000_100, 500), 50_005)
  assert.equal(markupCents(333, 500), 17)
  assert.equal(markupCents(330, 500), 17)
  assert.equal(markupCents(329, 500), 16)
  const first = buildShippingPriceBreakdown(10_001, 500)
  const second = buildShippingPriceBreakdown(10_001, 500)
  assert.deepEqual(first, second)
})

test("el porcentaje se valida: 0 a 50, hasta 2 decimales, sin NaN/Infinity", () => {
  assert.equal(markupPercentToBasisPoints(0), 0)
  assert.equal(markupPercentToBasisPoints(6), 600)
  assert.equal(markupPercentToBasisPoints("2,25"), 225)
  for (const bad of [-1, 50.01, Number.NaN, Infinity, "abc", null, 1.234]) {
    assert.throws(() => markupPercentToBasisPoints(bad), ShippingMarkupError)
  }
})

test("un desglose manipulado se detecta como inconsistente", () => {
  const breakdown = buildShippingPriceBreakdown(10_000, 500)
  assert.equal(isConsistentShippingPriceBreakdown(breakdown), true)
  assert.equal(isConsistentShippingPriceBreakdown({ ...breakdown, markupCents: 0 }), false)
  assert.equal(isConsistentShippingPriceBreakdown({ ...breakdown, logisticsCents: 100 }), false)
})

test("checkout vs bulto real: diferencia y alerta sólo si es considerable", () => {
  assert.deepEqual(compareParcelQuote(1_000_000, 1_038_000), { differenceCents: 38_000, differencePercent: 3.8, alert: false })
  assert.deepEqual(compareParcelQuote(1_000_000, 970_000), { differenceCents: -30_000, differencePercent: -3, alert: false })
  assert.equal(compareParcelQuote(1_020_000, 1_203_600).alert, true)
  assert.equal(compareParcelQuote(200_000, 240_000).alert, false, "18% pero sólo $400")
})

test("redondeo de envíos a $10: ejemplos exactos, mitad hacia arriba, sin centavos", () => {
  for (const [amount, expected] of [[987, 990], [553, 550], [106, 110], [10_543, 10_540], [10_547, 10_550], [10_500, 10_500], [10_545, 10_550], [0, 0]] as const) {
    assert.equal(roundShippingToNearestTen(amount), expected, `${amount}`)
  }
  assert.equal(roundShippingCentsToNearestTen(1_054_499), 1_054_000)
  assert.throws(() => roundShippingCentsToNearestTen(-1), ShippingMarkupError)
})
