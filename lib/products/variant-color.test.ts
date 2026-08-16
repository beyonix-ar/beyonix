import assert from "node:assert/strict"
import test from "node:test"

import {
  buildDiscountedSkuSuggestion,
  deriveVariantNameFromColor,
  getColorAbbreviation,
  getColorName,
} from "./variant-color.ts"

test("resuelve el nombre de colores conocidos por hex", () => {
  assert.equal(getColorName("#000000"), "Negro")
  assert.equal(getColorName("#ffffff"), "Blanco")
  assert.equal(getColorName("#2563EB"), "Azul")
})

test("cae al nombre de la variante cuando el hex no es conocido", () => {
  assert.equal(getColorName("#A3B2C1", "Turquesa"), "Turquesa")
})

test("un nombre de variante genérico no se usa como nombre de color", () => {
  assert.equal(getColorName("#A3B2C1", "Principal"), "Color personalizado")
  assert.equal(getColorName("#A3B2C1", "Variante 2"), "Color personalizado")
})

test("la tabla de abreviaturas de colores comunes coincide con lo esperado", () => {
  assert.equal(getColorAbbreviation("#000000"), "Neg")
  assert.equal(getColorAbbreviation("#FFFFFF"), "Bla")
  assert.equal(getColorAbbreviation("#EF4444"), "Roj")
  assert.equal(getColorAbbreviation("#2563EB"), "Azu")
  assert.equal(getColorAbbreviation("#22C55E"), "Ver")
  assert.equal(getColorAbbreviation("#6B7280"), "Gri")
})

test("un color con nombre propio de variante genera una abreviatura equivalente sin tabla rígida", () => {
  assert.equal(getColorAbbreviation("#A3B2C1", "Turquesa"), "Tur")
})

test("un color sin nombre resuelto cae a un código determinístico basado en el hex", () => {
  const first = getColorAbbreviation("#A3B2C1", "Principal")
  const second = getColorAbbreviation("#A3B2C1", "Principal")
  assert.equal(first, second)
  assert.match(first, /^[A-Z0-9]{3}$/)
})

test("deriveVariantNameFromColor resuelve colores conocidos sin depender de un nombre libre", () => {
  assert.equal(deriveVariantNameFromColor("#000000"), "Negro")
  assert.equal(deriveVariantNameFromColor("#ffffff"), "Blanco")
})

test("deriveVariantNameFromColor identifica cada hex personalizado por su propio código", () => {
  const primero = deriveVariantNameFromColor("#A3B2C1")
  const segundo = deriveVariantNameFromColor("#123456")
  assert.equal(primero, "Color #A3B2C1")
  assert.equal(segundo, "Color #123456")
  assert.notEqual(primero, segundo)
})

test("deriveVariantNameFromColor cae al genérico sólo si el hex no es válido", () => {
  assert.equal(deriveVariantNameFromColor(""), "Color personalizado")
  assert.equal(deriveVariantNameFromColor(null), "Color personalizado")
})

test("genera el SKU sugerido en el formato <sku original>-<color>-<%descuento>", () => {
  const suggestion = buildDiscountedSkuSuggestion({
    originalSku: "AP01",
    colorHex: "#000000",
    colorName: "Negro",
    discountPercent: 30,
  })

  assert.equal(suggestion, "AP01-Neg-30")
})

test("redondea el porcentaje y usa COND cuando no hay SKU original", () => {
  const suggestion = buildDiscountedSkuSuggestion({
    originalSku: null,
    colorHex: "#FFFFFF",
    colorName: "Blanco",
    discountPercent: 24.6,
  })

  assert.equal(suggestion, "COND-Bla-25")
})

test("la sugerencia cambia si cambia el color o el descuento manteniendo el mismo SKU base", () => {
  const base = { originalSku: "AP01", discountPercent: 30 }
  const negro = buildDiscountedSkuSuggestion({
    ...base,
    colorHex: "#000000",
    colorName: "Negro",
  })
  const blanco = buildDiscountedSkuSuggestion({
    ...base,
    colorHex: "#FFFFFF",
    colorName: "Blanco",
  })
  const otroDescuento = buildDiscountedSkuSuggestion({
    ...base,
    colorHex: "#000000",
    colorName: "Negro",
    discountPercent: 15,
  })

  assert.notEqual(negro, blanco)
  assert.notEqual(negro, otroDescuento)
  assert.equal(negro, "AP01-Neg-30")
  assert.equal(otroDescuento, "AP01-Neg-15")
})
