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
  packagingWeightGrams,
  PACKING_PADDING_PER_SIDE_CM,
  type PackingUnit,
} from "./package-estimator.ts"

const LIMITS = { maxWeightKg: 50, maxSideCm: 500 }
const unit = (lengthCm: number, widthCm: number, heightCm: number, weightKg: number, quantity = 1): PackingUnit =>
  ({ lengthCm, widthCm, heightCm, weightKg, quantity })
const PAD = PACKING_PADDING_PER_SIDE_CM * 2

test("1 unidad 10×10×10 de 1 kg: caja del producto + burbuja, peso con embalaje", () => {
  const estimate = estimatePackages([unit(10, 10, 10, 1)], LIMITS)
  assert.equal(estimate.parcels.length, 1)
  const [parcel] = estimate.parcels
  assert.deepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [10 + PAD, 10 + PAD, 10 + PAD])
  assert.equal(parcel.volumeCm3, 12 * 12 * 12)
  assert.equal(parcel.productsWeightKg, 1)
  assert.equal(parcel.productsVolumeCm3, 1_000)
  assert.equal(parcel.weightKg, 1.1)
})

test("2 unidades iguales se acomodan juntas, no se suman todos los lados", () => {
  const [parcel] = estimatePackages([unit(10, 10, 10, 1, 2)], LIMITS).parcels
  assert.deepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [22, 12, 12])
  assert.equal(parcel.productsWeightKg, 2)
})

test("15 unidades pequeñas 10×10×5: forma compacta, nunca una fila de 15 ni 150×150×75", () => {
  const [parcel] = estimatePackages([unit(10, 10, 5, 0.2, 15)], LIMITS).parcels
  assert.deepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [22, 22, 22])
  assert.ok(parcel.lengthCm < 150 && parcel.lengthCm < 15 * 10)
  assert.ok(parcel.volumeCm3 >= 15 * 500)
  assert.equal(parcel.productsWeightKg, 3)
})

test("grilla Nx×Ny×Nz: elige la disposición de menor superficie", () => {
  const { dims, counts } = bestGridArrangement([20, 15, 8], 5)
  assert.deepEqual(dims, [40, 20, 15])
  assert.equal(counts[0] * counts[1] * counts[2], 5)
  const twelve = bestGridArrangement([10, 10, 10], 12)
  assert.deepEqual(twelve.dims, [30, 20, 20])
})

test("productos diferentes: nunca más chico que el mayor y contiene el volumen con margen", () => {
  const units = [unit(20, 15, 8, 0.45), unit(30, 20, 10, 1.2), unit(12, 8, 4, 0.15)]
  const [parcel] = estimatePackages(units, LIMITS).parcels
  assert.ok(parcel.lengthCm >= 30 + PAD && parcel.widthCm >= 20 + PAD && parcel.heightCm >= 10 + PAD)
  const productsVolume = 20 * 15 * 8 + 30 * 20 * 10 + 12 * 8 * 4
  assert.equal(parcel.productsVolumeCm3, productsVolume)
  assert.ok(parcel.volumeCm3 >= productsVolume * MIXED_PACKING_VOLUME_FACTOR)
  assert.deepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [32, 22, 19])
  assert.equal(parcel.productsWeightKg, 1.8)
})

test("producto muy grande + producto pequeño: el chico entra en la huella del grande", () => {
  const [parcel] = estimatePackages([unit(80, 50, 40, 12), unit(10, 8, 5, 0.2)], LIMITS).parcels
  assert.equal(parcel.lengthCm, 82)
  assert.equal(parcel.widthCm, 52)
  assert.ok(parcel.heightCm >= 42 && parcel.heightCm < 60)
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
  assert.equal(estimate.productsVolumeCm3, 3 * 1_000 + 4 * 1_000)
})

test("margen de embalaje en peso: base + proporcional, con tope", () => {
  assert.equal(packagingWeightGrams(1_000), 100)
  assert.equal(packagingWeightGrams(450), 73)
  assert.equal(packagingWeightGrams(100_000), 1_500)
})

test("se divide en bultos sólo por el límite de peso con embalaje; una unidad imposible se rechaza", () => {
  const estimate = estimatePackages([unit(30, 30, 30, 10, 7)], LIMITS)
  assert.equal(estimate.parcels.length, 2)
  assert.ok(estimate.parcels.every((parcel) => parcel.weightKg <= 50))
  assert.equal(estimate.parcels.reduce((sum, parcel) => sum + parcel.units, 0), 7)
  assert.equal(estimate.productsWeightKg, 70)
  assert.throws(
    () => estimatePackages([unit(30, 30, 30, 49.99)], LIMITS),
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

test("producto chico: encendedor 0,072 kg (72 g) y 34 × 7 × 3,5 cm", () => {
  const [parcel] = estimatePackages([unit(34, 7, 3.5, 0.072)], LIMITS).parcels
  assert.equal(kilogramsToGrams(0.072), 72)
  assert.equal(parcel.productsWeightKg, 0.072)
  // 72 g + embalaje (50 g + 5% = 54 g) = 126 g; 3,5 cm se toma como 4 cm.
  assert.equal(parcel.weightKg, 0.126)
  assert.deepEqual([parcel.lengthCm, parcel.widthCm, parcel.heightCm], [36, 9, 6])
})

test("multiplicidad del mismo producto: 1, 2, 5 y 15 unidades nunca suman lados", () => {
  const sizes = [1, 2, 5, 15].map((quantity) => {
    const [parcel] = estimatePackages([unit(20, 15, 8, 0.45, quantity)], LIMITS).parcels
    assert.equal(parcel.productsWeightKg, gramsToKilograms(450 * quantity))
    assert.equal(parcel.productsVolumeCm3, 2_400 * quantity)
    assert.ok(parcel.volumeCm3 >= parcel.productsVolumeCm3)
    assert.ok(parcel.lengthCm < 20 * quantity + 2 || quantity === 1, `${quantity} unidades`)
    return [parcel.lengthCm, parcel.widthCm, parcel.heightCm]
  })
  assert.deepEqual(sizes, [[22, 17, 10], [22, 18, 17], [42, 22, 17], [42, 34, 32]])
})
