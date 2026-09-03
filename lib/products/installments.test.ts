import assert from "node:assert/strict"
import test from "node:test"

import {
  getCartInstallmentEligibility,
  getEffectiveInstallmentPercent,
  getEligibleInstallmentCounts,
  getEligibleInstallmentDisplayPlans,
  getInstallmentPlanLabels,
  getMaxInstallmentPlanLabel,
  getPlainInstallmentAmount,
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

test("el % efectivo se deriva de costo base + costo por cuotas + IVA, nunca de una constante -- SOLO uso interno (Admin: rentabilidad/precio objetivo), nunca se le suma al precio del cliente", () => {
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

// ─────────────────────────────────────────────────────────────
// CASO A (informe final #22): precio público $6.000, 2/3/6 habilitadas.
// El total nunca cambia; sólo cambia cuánto vale cada cuota informativa.
// ─────────────────────────────────────────────────────────────

test("PRECIO PÚBLICO ÚNICO: getPlainInstallmentAmount nunca reconstruye un total distinto -- sólo divide", () => {
  assert.equal(getPlainInstallmentAmount(6_000, 2), 3_000)
  assert.equal(getPlainInstallmentAmount(6_000, 3), 2_000)
  assert.equal(getPlainInstallmentAmount(6_000, 6), 1_000)

  // El total sigue siendo $6.000 sin importar la cuota elegida: la prueba
  // de que "no hay gross-up" es que count * installmentAmount == price
  // cuando divide exacto (no un total mayor a medida que crecen las cuotas).
  for (const count of [2, 3, 6] as const) {
    const installmentAmount = getPlainInstallmentAmount(6_000, count)!
    assert.equal(installmentAmount * count, 6_000)
  }
})

test("getPlainInstallmentAmount: división monetaria correcta cuando no divide exacto (redondeo al peso, no se infla el total)", () => {
  // 75.000 / 3 = 25.000 exacto.
  assert.equal(getPlainInstallmentAmount(75_000, 3), 25_000)
  // 75.000 / 6 = 12.500 exacto.
  assert.equal(getPlainInstallmentAmount(75_000, 6), 12_500)
  // 70.000 / 6 = 11.666.66... -> redondeo al peso más cercano, sin ajustar
  // el total: 6 * 11.667 = 70.002 (unos centavos de diferencia informativa,
  // nunca se "corrige" cobrando de más).
  const installmentAmount = getPlainInstallmentAmount(70_000, 6)!
  assert.equal(installmentAmount, 11_667)
  assert.ok(Math.abs(installmentAmount * 6 - 70_000) < 10)
})

test("un monto base inválido o cero no genera cuota", () => {
  assert.equal(getPlainInstallmentAmount(0, 3), null)
  assert.equal(getPlainInstallmentAmount(-100, 3), null)
  assert.equal(getPlainInstallmentAmount(Number.NaN, 3), null)
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

test("producto sin ninguna cuota habilitada nunca genera un plan de cara al cliente", () => {
  const producto = noFinancing()
  assert.deepEqual(getEligibleInstallmentCounts(producto), [])
  assert.deepEqual(getEligibleInstallmentDisplayPlans(producto, 75_000), [])
})

test("las etiquetas de cara al cliente nunca mencionan porcentaje, comisión, recargo ni 'financiado' -- y ya no dicen 'sin interés' (copy neutral, ver informe de precio único)", () => {
  const producto = noFinancing({ cuotas_3_habilitadas: true, cuotas_6_habilitadas: true })
  const labels = getInstallmentPlanLabels(producto, 75_000)

  assert.deepEqual(labels, [
    "Hasta 3 cuotas de $25.000",
    "Hasta 6 cuotas de $12.500",
  ])
  for (const label of labels) {
    assert.doesNotMatch(label, /%|financiad|comisi[oó]n|recargo|sin inter[eé]s/i)
    // Checkout Pro fija "installments" como TOPE ofrecido, no como cantidad
    // obligatoria: el texto nunca puede prometer "N cuotas" a secas, porque
    // Mercado Pago puede terminar ofreciendo menos según el medio de pago.
    assert.match(label, /^Hasta \d+ cuotas de \$/)
  }
})

test("un producto sin cuotas habilitadas no genera ninguna etiqueta", () => {
  assert.deepEqual(getInstallmentPlanLabels(noFinancing(), 75_000), [])
})

test("la etiqueta usa el precio efectivamente mostrado, no un precio de producto fijo", () => {
  const producto = noFinancing({ cuotas_3_habilitadas: true })
  // Precio de una variante/condicionado distinto al del producto base.
  const labels = getInstallmentPlanLabels(producto, 50_000)
  assert.notDeepEqual(labels, getInstallmentPlanLabels(producto, 75_000))
})

test("getMaxInstallmentPlanLabel: muestra siempre la MAYOR modalidad habilitada, para superficies compactas (card/PDP)", () => {
  const price = 6_000

  // Sólo 2 -> "Hasta 2..."
  assert.equal(
    getMaxInstallmentPlanLabel(noFinancing({ cuotas_2_habilitadas: true }), price),
    "Hasta 2 cuotas de $3.000",
  )

  // Sólo 3 -> "Hasta 3..."
  assert.equal(
    getMaxInstallmentPlanLabel(noFinancing({ cuotas_3_habilitadas: true }), price),
    "Hasta 3 cuotas de $2.000",
  )

  // Sólo 6 -> "Hasta 6..."
  assert.equal(
    getMaxInstallmentPlanLabel(noFinancing({ cuotas_6_habilitadas: true }), price),
    "Hasta 6 cuotas de $1.000",
  )

  // 2 + 3 -> "Hasta 3..."
  assert.equal(
    getMaxInstallmentPlanLabel(
      noFinancing({ cuotas_2_habilitadas: true, cuotas_3_habilitadas: true }),
      price,
    ),
    "Hasta 3 cuotas de $2.000",
  )

  // 2 + 6 -> "Hasta 6..."
  assert.equal(
    getMaxInstallmentPlanLabel(
      noFinancing({ cuotas_2_habilitadas: true, cuotas_6_habilitadas: true }),
      price,
    ),
    "Hasta 6 cuotas de $1.000",
  )

  // 3 + 6 -> "Hasta 6..."
  assert.equal(
    getMaxInstallmentPlanLabel(
      noFinancing({ cuotas_3_habilitadas: true, cuotas_6_habilitadas: true }),
      price,
    ),
    "Hasta 6 cuotas de $1.000",
  )

  // 2 + 3 + 6 -> "Hasta 6..." -- y el precio público sigue siendo $6.000 en los 4 casos (1 pago, 2, 3, 6).
  assert.equal(
    getMaxInstallmentPlanLabel(
      noFinancing({ cuotas_2_habilitadas: true, cuotas_3_habilitadas: true, cuotas_6_habilitadas: true }),
      price,
    ),
    "Hasta 6 cuotas de $1.000",
  )

  // Ninguna -> null
  assert.equal(getMaxInstallmentPlanLabel(noFinancing(), price), null)
})
