import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { parseArgentineStreetAddress } from "./address-parsing.ts"
import { ANDREANI_STREET_NUMBER_MAX_DIGITS } from "./shipment-limits.ts"

// BLOQUEANTE 2 (auditoría Andreani Parte 2/4): confirma la causa raíz real
// del bug reportado ("altura de 7 dígitos aceptada en checkout, rechazada al
// crear el envío") y que quedó cerrada en la fuente compartida, no en un
// parche puntual.

test("una altura de hasta 6 dígitos se identifica correctamente", () => {
  const result = parseArgentineStreetAddress("Avenida Siempreviva 123456")
  assert.equal(result.calle, "Avenida Siempreviva")
  assert.equal(result.numero, "123456")
})

test("BLOQUEANTE 2: una altura de 7+ dígitos NUNCA se inventa -- numero queda vacío, igual que 'sin altura'", () => {
  const withSevenDigits = parseArgentineStreetAddress("Avenida Siempreviva 1234567")
  assert.equal(withSevenDigits.numero, "")

  const withoutNumber = parseArgentineStreetAddress("Ruta provincial sin altura")
  assert.equal(withoutNumber.numero, "")
})

test("el límite de dígitos de altura es EXACTAMENTE ANDREANI_STREET_NUMBER_MAX_DIGITS -- una fuente compartida, no un número mágico duplicado", () => {
  const exactLimit = "1".repeat(ANDREANI_STREET_NUMBER_MAX_DIGITS)
  const overLimit = "1".repeat(ANDREANI_STREET_NUMBER_MAX_DIGITS + 1)

  assert.equal(parseArgentineStreetAddress(`Calle Falsa ${exactLimit}`).numero, exactLimit)
  assert.equal(parseArgentineStreetAddress(`Calle Falsa ${overLimit}`).numero, "")
})

test("order-shipment.ts, checkout-order-creation.ts y account-fields.ts comparten la misma fuente de límites Andreani -- ningún número mágico duplicado", () => {
  const orderShipmentSource = readFileSync(
    new URL("./order-shipment.ts", import.meta.url),
    "utf8",
  )
  const checkoutOrderCreationSource = readFileSync(
    new URL("../orders/checkout-order-creation.ts", import.meta.url),
    "utf8",
  )

  assert.match(orderShipmentSource, /from ["']\.\/shipment-limits\.ts["']/)
  assert.match(orderShipmentSource, /from ["']\.\/address-parsing\.ts["']/)
  assert.match(
    checkoutOrderCreationSource,
    /from ["']\.\.\/andreani\/shipment-limits\.ts["']/,
  )
  assert.match(
    checkoutOrderCreationSource,
    /from ["']\.\.\/andreani\/address-parsing\.ts["']/,
  )
})
