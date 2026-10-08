import assert from "node:assert/strict"
import test from "node:test"

import {
  deriveDualColorVariantName,
  hexToBaseColor,
  primaryColorName,
  readableColorName,
  variantBaseColors,
} from "./product-color-filters.ts"

test("hex → color base del filtro", () => {
  const cases: Array<[string, string]> = [
    ["#000000", "negro"], ["#18181B", "negro"], ["#FFFFFF", "blanco"], ["#6B7280", "gris"],
    ["#2563EB", "azul"], ["#38BDF8", "azul"], ["#EF4444", "rojo"], ["#22C55E", "verde"],
    ["#FACC15", "amarillo"], ["#EC4899", "rosa"], ["#8B5CF6", "violeta"], ["#D6D3D1", "gris"],
    ["#F5E6C8", "beige"], ["#92400E", "rojo"],
  ]
  for (const [hex, expected] of cases) assert.equal(hexToBaseColor(hex), expected, hex)
  assert.equal(hexToBaseColor("rosa"), null)
  assert.equal(hexToBaseColor(null), null)
})

test("variante bicolor Azul/Rosa aparece al filtrar por Azul y por Rosa (sin color artificial)", () => {
  const colors = variantBaseColors({ name: "AZUL / ROSA", colorHex: "#2563EB", secondaryColorHex: "#EC4899" })
  assert.ok(colors.has("azul"))
  assert.ok(colors.has("rosa"))
  assert.equal(colors.size, 2)
})

test("un color personalizado sin nombre (COLOR #hex) igual se filtra por su hex", () => {
  assert.deepEqual([...variantBaseColors({ name: "COLOR #8797BF", colorHex: "#8797BF" })], ["azul"])
})

test("legacy: una variante de un color sigue igual", () => {
  assert.deepEqual([...variantBaseColors({ name: "NEGRO", colorHex: "#000000" })], ["negro"])
  assert.equal(deriveDualColorVariantName("NEGRO", null), "NEGRO")
  assert.equal(primaryColorName("NEGRO"), "NEGRO")
})

test("nombre bicolor: principal elegido + segundo color legible", () => {
  assert.equal(deriveDualColorVariantName("AZUL", "#EC4899"), "AZUL / ROSA")
  assert.equal(deriveDualColorVariantName("AZUL / VERDE", "#EF4444"), "AZUL / ROJO")
  assert.equal(deriveDualColorVariantName("AZUL / ROSA", null), "AZUL")
  assert.equal(primaryColorName("AZUL / ROSA"), "AZUL")
  assert.equal(readableColorName("#000000"), "NEGRO")
})
