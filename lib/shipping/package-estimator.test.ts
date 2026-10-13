import assert from "node:assert/strict"
import test from "node:test"

import {
  bestGridArrangement,
  gramsToKilograms,
  kilogramsToGrams,
  compactBoxForVolume,
  estimatePackages,
  MIXED_PACKING_VOLUME_FACTOR,
  PackageEstimateError,
  type PackingUnit,
} from "./package-estimator.ts"

const LIMITS = { maxWeightKg: 50, maxSideCm: 500 }
const unit = (lengthCm: number, widthCm: number, heightCm: number, weightKg: number, quantity = 1): PackingUnit =>
  ({ lengthCm, widthCm, heightCm, weightKg, quantity })

test("caso real: 1 unidad lista para despacho (0,65 kg, 28 × 16 × 14) se cotiza TAL CUAL", () => {
  const estimate = estimatePackages([unit(28, 16, 14, 0.65)], LIMITS)
  assert.equal(estimate.parcels.length, 1)
  const [parcel] = estimate.parcels
  assert.deepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [28, 16, 14])
  assert.equal(parcel.volumeCm3, 6_272)
  assert.equal(parcel.weightKg, 0.65)
  // Regresión del margen duplicado: nunca 30 × 18 × 16 / 8.640 cm³ / 0,733 kg.
  assert.notDeepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [30, 18, 16])
  assert.notEqual(parcel.weightKg, 0.733)
  assert.equal(estimate.totalWeightKg, 0.65)
  assert.equal(estimate.totalVolumeCm3, 6_272)
})

test("1 unidad: sin relleno por lado ni peso de embalaje, en cualquier orden de lados", () => {
  const [parcel] = estimatePackages([unit(10, 10, 10, 1)], LIMITS).parcels
  assert.deepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [10, 10, 10])
  assert.equal(parcel.volumeCm3, 1_000)
  assert.equal(parcel.weightKg, 1)
  assert.equal(parcel.productsWeightKg, 1)
  assert.equal(parcel.productsVolumeCm3, 1_000)
  const [rotated] = estimatePackages([unit(14, 28, 16, 0.65)], LIMITS).parcels
  assert.deepEqual([rotated.lengthCm, rotated.widthCm, rotated.heightCm], [28, 16, 14])
})

test("medidas con decimales se respetan (encendedor 0,072 kg y 34 × 7 × 3,5 cm)", () => {
  const [parcel] = estimatePackages([unit(34, 7, 3.5, 0.072)], LIMITS).parcels
  assert.equal(kilogramsToGrams(0.072), 72)
  assert.equal(parcel.weightKg, 0.072)
  assert.deepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [34, 7, 3.5])
  assert.equal(parcel.volumeCm3, 833)
})

test("varias unidades iguales: peso = suma exacta, se acomodan juntas sin inflar cada unidad", () => {
  const [two] = estimatePackages([unit(10, 10, 10, 1, 2)], LIMITS).parcels
  assert.deepEqual([two.lengthCm, two.widthCm, two.heightCm], [20, 10, 10])
  assert.equal(two.weightKg, 2)
  assert.equal(two.volumeCm3, 2_000)

  const [doubleReal] = estimatePackages([unit(28, 16, 14, 0.65, 2)], LIMITS).parcels
  assert.equal(doubleReal.weightKg, 1.3)
  assert.equal(doubleReal.volumeCm3, 2 * 6_272, "2 unidades = 2 veces el volumen declarado, sin margen extra")
})

test("15 unidades pequeñas 10×10×5: forma compacta, nunca una fila de 15", () => {
  const [parcel] = estimatePackages([unit(10, 10, 5, 0.2, 15)], LIMITS).parcels
  assert.deepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [20, 20, 20])
  assert.ok(parcel.volumeCm3 >= 15 * 500)
  assert.equal(parcel.productsWeightKg, 3)
  assert.equal(parcel.weightKg, 3)
})

test("grilla Nx×Ny×Nz: elige la disposición de menor superficie", () => {
  const { dims, counts } = bestGridArrangement([20, 15, 8], 5)
  assert.deepEqual(dims, [40, 20, 15])
  assert.equal(counts[0] * counts[1] * counts[2], 5)
  const twelve = bestGridArrangement([10, 10, 10], 12)
  assert.deepEqual(twelve.dims, [30, 20, 20])
})

test("productos distintos: nunca más chico que el mayor, contiene el volumen combinado y el peso es la suma exacta", () => {
  const units = [unit(20, 15, 8, 0.45), unit(30, 20, 10, 1.2), unit(12, 8, 4, 0.15)]
  const [parcel] = estimatePackages(units, LIMITS).parcels
  assert.ok(parcel.lengthCm >= 30 && parcel.widthCm >= 20 && parcel.heightCm >= 10)
  const productsVolume = 20 * 15 * 8 + 30 * 20 * 10 + 12 * 8 * 4
  assert.equal(parcel.productsVolumeCm3, productsVolume)
  assert.ok(parcel.volumeCm3 >= productsVolume * MIXED_PACKING_VOLUME_FACTOR)
  // Sólo el factor de combinación (+15% de volumen); sin +2 cm por lado.
  assert.deepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [30, 20, 17])
  assert.equal(parcel.productsWeightKg, 1.8)
  assert.equal(parcel.weightKg, 1.8, "sin peso de embalaje")
})

test("producto muy grande + producto pequeño: el chico entra en la huella del grande", () => {
  const [parcel] = estimatePackages([unit(80, 50, 40, 12), unit(10, 8, 5, 0.2)], LIMITS).parcels
  assert.equal(parcel.lengthCm, 80)
  assert.equal(parcel.widthCm, 50)
  assert.ok(parcel.heightCm >= 40 && parcel.heightCm < 60)
  assert.equal(parcel.weightKg, 12.2)
})

test("crecimiento compacto: altura, luego ancho+alto y por último cubo", () => {
  assert.deepEqual(compactBoxForVolume([30, 20, 10], 6_000), [30, 20, 10])
  assert.deepEqual(compactBoxForVolume([30, 20, 10], 9_000), [30, 20, 15])
  const wide = compactBoxForVolume([30, 20, 10], 24_000)
  assert.ok(wide[0] === 30 && wide[1] >= 20 && wide[1] * wide[2] * 30 >= 24_000 && wide[1] <= 30)
  const cube = compactBoxForVolume([10, 5, 5], 64_000)
  assert.deepEqual(cube, [40, 40, 40])
})

test("cantidades múltiples de varias variantes: peso y volumen total exactos", () => {
  const estimate = estimatePackages([unit(10, 10, 10, 0.5, 3), unit(20, 10, 5, 0.25, 4)], LIMITS)
  assert.equal(estimate.productsWeightKg, 2.5)
  assert.equal(estimate.totalWeightKg, 2.5)
  assert.equal(estimate.productsVolumeCm3, 3 * 1_000 + 4 * 1_000)
})

test("se divide en bultos sólo por el límite de peso (sin reservar peso de embalaje); una unidad imposible se rechaza", () => {
  const estimate = estimatePackages([unit(30, 30, 30, 10, 7)], LIMITS)
  assert.equal(estimate.parcels.length, 2)
  assert.deepEqual(estimate.parcels.map((parcel) => parcel.units), [5, 2])
  assert.ok(estimate.parcels.every((parcel) => parcel.weightKg <= 50))
  assert.equal(estimate.productsWeightKg, 70)
  assert.equal(estimatePackages([unit(30, 30, 30, 50)], LIMITS).parcels[0].weightKg, 50)
  assert.throws(
    () => estimatePackages([unit(30, 30, 30, 50.01)], LIMITS),
    (error) => error instanceof PackageEstimateError && error.code === "UNIT_TOO_HEAVY",
  )
})

test("rechaza medidas, pesos o cantidades inválidas (0, negativos, NaN, Infinity)", () => {
  for (const bad of [unit(0, 1, 1, 1), unit(1, -1, 1, 1), unit(1, 1, Number.NaN, 1), unit(1, 1, 1, Infinity), unit(1, 1, 1, 1, 0)]) {
    assert.throws(() => estimatePackages([bad], LIMITS), PackageEstimateError)
  }
  assert.throws(() => estimatePackages([unit(600, 10, 10, 1)], LIMITS), (error) =>
    error instanceof PackageEstimateError && error.code === "UNIT_TOO_LARGE")
})

test("es determinista e independiente del orden de las líneas", () => {
  const units = [unit(20, 15, 8, 0.45, 2), unit(30, 20, 10, 1.2), unit(12, 8, 4, 0.15, 3)]
  const first = estimatePackages(units, LIMITS)
  const second = estimatePackages([...units].reverse(), LIMITS)
  assert.deepEqual(first, second)
})

test("nunca suma dimensiones ingenuamente aunque haya muchas unidades", () => {
  const [parcel] = estimatePackages([unit(3, 2, 1, 0.005, 5_000)], LIMITS).parcels
  assert.ok(parcel.lengthCm < 60, `lado mayor ${parcel.lengthCm}`)
  assert.ok(parcel.volumeCm3 >= 30_000)
})

test("multiplicidad del mismo producto: 1, 2, 5 y 15 unidades nunca suman lados ni agregan margen", () => {
  const sizes = [1, 2, 5, 15].map((quantity) => {
    const [parcel] = estimatePackages([unit(20, 15, 8, 0.45, quantity)], LIMITS).parcels
    assert.equal(parcel.productsWeightKg, gramsToKilograms(450 * quantity))
    assert.equal(parcel.weightKg, parcel.productsWeightKg)
    assert.equal(parcel.productsVolumeCm3, 2_400 * quantity)
    assert.ok(parcel.volumeCm3 >= parcel.productsVolumeCm3)
    assert.ok(parcel.lengthCm < 20 * quantity || quantity === 1, `${quantity} unidades`)
    return [parcel.lengthCm, parcel.widthCm, parcel.heightCm]
  })
  assert.deepEqual(sizes, [[20, 15, 8], [20, 16, 15], [40, 20, 15], [40, 32, 30]])
})
