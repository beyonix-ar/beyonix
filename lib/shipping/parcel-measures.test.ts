import assert from "node:assert/strict"
import test from "node:test"

import { parseMeasureText, parseParcelMeasures, ParcelMeasuresError } from "./parcel-measures.ts"

test("medidas reales: 1 y 2+ bultos válidos, redondeo a gramos y milímetros", () => {
  assert.deepEqual(parseParcelMeasures([{ weightKg: 2.4504, lengthCm: 40, widthCm: 30.04, heightCm: 20 }]), [
    { weightKg: 2.45, lengthCm: 40, widthCm: 30, heightCm: 20 },
  ])
  assert.equal(parseParcelMeasures([
    { weightKg: 1, lengthCm: 30, widthCm: 20, heightCm: 10 },
    { weightKg: 0.8, lengthCm: 25, widthCm: 20, heightCm: 8 },
  ]).length, 2)
})

test("medidas obligatorias: rechaza vacíos, cero, negativos, texto, NaN, Infinity y absurdos", () => {
  const ok = { weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 }
  for (const bad of [
    [],
    [{ ...ok, heightCm: undefined }],
    [{ ...ok, weightKg: 0 }],
    [{ ...ok, lengthCm: -5 }],
    [{ ...ok, widthCm: "10" }],
    [{ ...ok, weightKg: Number.NaN }],
    [{ ...ok, weightKg: Infinity }],
    [{ ...ok, weightKg: 1001 }],
    [{ ...ok, heightCm: 501 }],
    Array.from({ length: 51 }, () => ok),
    "bultos",
  ]) {
    assert.throws(() => parseParcelMeasures(bad), ParcelMeasuresError)
  }
})

test("el texto del operador acepta coma decimal y rechaza basura", () => {
  assert.equal(parseMeasureText("2,450"), 2.45)
  assert.equal(parseMeasureText(" 40 "), 40)
  assert.equal(parseMeasureText(""), null)
  assert.equal(parseMeasureText("4o"), null)
  assert.equal(parseMeasureText("-3"), null)
})
