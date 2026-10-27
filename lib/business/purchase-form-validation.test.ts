import assert from "node:assert/strict"
import test from "node:test"

import {
  formatMissingFieldsMessage,
  isValidBarcode,
  isValidColorName,
  isValidSku,
  parseAmount,
  parsePositiveInteger,
  sanitizeAmount,
  sanitizeCode,
  sanitizeColorName,
  sanitizeInteger,
  validatePurchaseForm,
  type PurchaseFormInput,
} from "./purchase-form-validation.ts"

// Artículo nuevo completo: negro por defecto, sin nombre de color, flete 0.
const complete: PurchaseFormInput = {
  hasArticle: true,
  isNewArticle: true,
  articleName: "PAVA 12V",
  colorRequired: true,
  colorHex: "#000000",
  colorName: "",
  createsVariant: true,
  skuRequired: true,
  sku: "PAVA-12V-NEG",
  barcode: "",
  purchaseDate: "2026-10-26",
  quantity: "2",
  receptionStatus: "recibida",
  receivedQuantity: "",
  unitCost: "8852",
  freightCost: "0",
  otherCost: "600",
  documentNumber: "",
}

test("mensaje dinámico: uno, dos o tres+ campos, en el orden del formulario", () => {
  assert.equal(formatMissingFieldsMessage([]), null)
  assert.equal(formatMissingFieldsMessage(["sku"]), "Falta completar SKU.")
  assert.equal(formatMissingFieldsMessage(["quantity", "unitCost"]), "Falta completar Cantidad comprada y Costo unitario.")
  assert.equal(formatMissingFieldsMessage(["quantity", "color", "sku"]), "Falta completar Color, SKU y Cantidad comprada.")
})

test("A–D: el mensaje nombra sólo los campos que realmente faltan; completo no da falso error", () => {
  assert.deepEqual(validatePurchaseForm(complete), { fields: [], message: null }, "D")
  assert.deepEqual(validatePurchaseForm({ ...complete, sku: "" }), { fields: ["sku"], message: "Falta completar SKU." }, "A")
  assert.deepEqual(validatePurchaseForm({ ...complete, colorHex: "" }), { fields: ["color"], message: "Falta completar Color." }, "B")
  assert.deepEqual(
    validatePurchaseForm({ ...complete, quantity: "", unitCost: "" }),
    { fields: ["quantity", "unitCost"], message: "Falta completar Cantidad comprada y Costo unitario." },
    "C",
  )
  assert.equal(validatePurchaseForm({ ...complete, sku: " ", colorHex: "", quantity: "" }).message, "Falta completar Color, SKU y Cantidad comprada.")
  // Compra de una variante existente: ni color ni SKU obligatorios.
  assert.equal(validatePurchaseForm({ ...complete, isNewArticle: false, articleName: "", colorRequired: false, colorHex: "", createsVariant: false, skuRequired: false, sku: "" }).message, null)
  assert.equal(validatePurchaseForm({ ...complete, hasArticle: false, isNewArticle: false, colorRequired: false, createsVariant: false, skuRequired: false }).message, "Falta completar Artículo.")
})

test("P/Q: variante nueva con el negro por defecto y sin nombre de color es válida", () => {
  const validation = validatePurchaseForm({ ...complete, colorHex: "#000000", colorName: "" })
  assert.equal(validation.message, null)
  assert.equal(validation.fields.includes("color"), false)
})

test("Color obligatorio en toda variante nueva: vacío bloquea con \"Falta completar Color.\"", () => {
  for (const colorHex of ["", "   "]) {
    assert.deepEqual(validatePurchaseForm({ ...complete, colorHex }), { fields: ["color"], message: "Falta completar Color." })
    // Aunque el llamador no marque colorRequired, una variante nueva lo exige igual.
    assert.equal(validatePurchaseForm({ ...complete, colorRequired: false, createsVariant: true, colorHex }).message, "Falta completar Color.")
  }
  assert.deepEqual(validatePurchaseForm({ ...complete, colorHex: "negro" }), { fields: ["color"], message: "El color elegido no es válido." })
  assert.equal(validatePurchaseForm({ ...complete, colorHex: "#ECA2A2", colorName: "ROSA" }).message, null, "otro color sigue funcionando")
})

test("E–H: Flete vacío o 0 no bloquea; negativo o con letras sí", () => {
  for (const freightCost of ["0", "", "  ", "1500", "25000", "12500.50"]) {
    assert.equal(validatePurchaseForm({ ...complete, freightCost }).message, null, JSON.stringify(freightCost))
  }
  assert.equal(parseAmount(""), 0, "G: vacío = 0")
  assert.equal(parseAmount(undefined), 0)
  for (const freightCost of ["-100", "abc", "1e3", "Infinity", "NaN", "12.345"]) {
    const validation = validatePurchaseForm({ ...complete, freightCost })
    assert.deepEqual(validation.fields, ["freightCost"], freightCost)
    assert.match(validation.message ?? "", /Revisá Flete/)
  }
  assert.equal(parseAmount(-1), null)
  assert.equal(parseAmount(Number.POSITIVE_INFINITY), null)
  assert.equal(parseAmount(Number.NaN), null)
})

test("I–K: numéricos sin letras; Cantidad entera; importes con decimales", () => {
  assert.equal(sanitizeInteger("12a3"), "123")
  assert.equal(sanitizeInteger("1.5"), "15", "Cantidad no admite separador decimal")
  assert.equal(parsePositiveInteger("1.5"), null, "J")
  assert.equal(parsePositiveInteger("0"), null)
  assert.equal(parsePositiveInteger("3"), 3)
  assert.equal(validatePurchaseForm({ ...complete, quantity: "1.5" }).fields[0], "quantity")
  assert.equal(validatePurchaseForm({ ...complete, quantity: "0" }).message, "La cantidad comprada debe ser un número entero mayor que cero.")

  assert.equal(sanitizeAmount("abc1500"), "1500", "I: letras afuera")
  assert.equal(sanitizeAmount("-250"), "250", "sin signo negativo")
  assert.equal(sanitizeAmount("12500,50"), "12500.50", "K: coma decimal")
  assert.equal(sanitizeAmount("12500.50"), "12500.50")
  assert.equal(sanitizeAmount("$ 12.500,50"), "12500.50", "pegado en formato es-AR")
  assert.equal(sanitizeAmount("10,999"), "10.99", "hasta 2 decimales")
  assert.equal(parseAmount("12500.50"), 12500.5)
  assert.equal(parseAmount("12500,50"), null, "la API recibe el valor ya normalizado")
})

test("L/M: nombre del color acepta español y rechaza números", () => {
  for (const name of ["Verde", "Azul Marino", "Rosa Pastel", "Ñandú", "Pingüino", "Gris (mate)", "Verde-agua", "Café"]) {
    assert.equal(isValidColorName(name), true, name)
  }
  for (const name of ["Verde123", "123", "Azul #2", "  "]) {
    assert.equal(isValidColorName(name), false, name)
  }
  assert.equal(sanitizeColorName("Verde123"), "Verde")
  assert.equal(sanitizeColorName("Azul Marino ñ"), "Azul Marino ñ")
  const validation = validatePurchaseForm({ ...complete, colorName: "VERDE123" })
  assert.deepEqual(validation.fields, ["colorName"])
  assert.match(validation.message ?? "", /sin números/)
  // Un nombre ya guardado de una variante existente no se revalida.
  assert.equal(validatePurchaseForm({ ...complete, createsVariant: false, colorName: "COLOR #C9A3B0" }).message, null)
})

test("N/O: SKU y código alfanuméricos; nombre de artículo mixto sin restricción", () => {
  for (const sku of ["ABC123", "BX-001", "LEGATUS-NEGRO-01", "P-1400-V", "AUR_01", "A.B/2"]) {
    assert.equal(isValidSku(sku), true, sku)
  }
  for (const sku of ["ABC 123", "ABC$", "-", "Ñ#1"]) {
    assert.equal(isValidSku(sku), false, sku)
  }
  assert.equal(sanitizeCode("bx 001$"), "bx001")
  assert.equal(isValidBarcode("7790000000001"), true)
  assert.equal(isValidBarcode("BX-PRO-001400"), true)
  assert.equal(isValidBarcode("779 000"), false)
  for (const articleName of ["PAVA 12V", "HUB USB 3.0", "Lámpara Ñandú"]) {
    assert.equal(validatePurchaseForm({ ...complete, articleName }).message, null, articleName)
  }
  assert.deepEqual(validatePurchaseForm({ ...complete, sku: "ABC 123" }).fields, ["sku"])
})

test("recepción parcial y número de comprobante", () => {
  const partial = { ...complete, receptionStatus: "parcial" as const }
  assert.equal(validatePurchaseForm({ ...partial, receivedQuantity: "" }).message, "Falta completar Cantidad recibida.")
  assert.match(validatePurchaseForm({ ...partial, receivedQuantity: "2" }).message ?? "", /menor que la cantidad comprada/)
  assert.equal(validatePurchaseForm({ ...partial, receivedQuantity: "1" }).message, null)
  assert.equal(validatePurchaseForm({ ...complete, documentNumber: "A-0001-00001234" }).message, null)
  assert.deepEqual(validatePurchaseForm({ ...complete, documentNumber: "0001$" }).fields, ["documentNumber"])
})
