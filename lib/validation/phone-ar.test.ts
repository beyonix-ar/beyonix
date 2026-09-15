import assert from "node:assert/strict"
import test from "node:test"

import {
  ARGENTINA_NATIONAL_PHONE_MAX_LENGTH,
  ARGENTINA_NATIONAL_PHONE_MIN_LENGTH,
  ARGENTINA_PHONE_PREFIX,
  formatArgentinePhoneForDisplay,
  isValidArgentineNationalPhone,
  normalizeArgentineNationalPhone,
} from "./phone-ar.ts"

test("1. tipeado simple, sin nada que limpiar", () => {
  assert.equal(normalizeArgentineNationalPhone("3411234567"), "3411234567")
})

test("2. pegado con +54 (código de país + número completo)", () => {
  assert.equal(normalizeArgentineNationalPhone("+54 3411234567"), "3411234567")
  assert.equal(normalizeArgentineNationalPhone("+543411234567"), "3411234567")
})

test("3. pegado con 0 inicial (larga distancia nacional)", () => {
  assert.equal(normalizeArgentineNationalPhone("03411234567"), "3411234567")
})

test("4. espacios", () => {
  assert.equal(normalizeArgentineNationalPhone("341 1234567"), "3411234567")
  assert.equal(normalizeArgentineNationalPhone("3 4 1 1 2 3 4 5 6 7"), "3411234567")
})

test("5. guiones", () => {
  assert.equal(normalizeArgentineNationalPhone("341-1234567"), "3411234567")
  assert.equal(normalizeArgentineNationalPhone("341-123-4567"), "3411234567")
})

test("6. paréntesis (formato de área entre paréntesis)", () => {
  assert.equal(normalizeArgentineNationalPhone("(341) 1234567"), "3411234567")
})

test("combinado: espacios + guiones + paréntesis + +54 en un mismo pegado", () => {
  assert.equal(normalizeArgentineNationalPhone("+54 (341) 123-4567"), "3411234567")
})

test("7. +54 duplicado nunca queda pegado en el resultado", () => {
  assert.equal(normalizeArgentineNationalPhone("+54+54 341 1234567"), "3411234567")
  assert.equal(normalizeArgentineNationalPhone("5454 3411234567"), "3411234567")
  // Nunca debe sobrevivir un "54" colgando al principio del resultado final.
  assert.doesNotMatch(normalizeArgentineNationalPhone("+54+54 341 1234567"), /^54/)
})

test("formato típico de WhatsApp/agenda (+54 9 ...): el 9 pegado junto al código de país se descarta, nunca uno tipeado a mano", () => {
  assert.equal(normalizeArgentineNationalPhone("+54 9 341 123-4567"), "3411234567")
  assert.equal(normalizeArgentineNationalPhone("+5493411234567"), "3411234567")

  // Tipeado a mano, SIN +54 pegado: un 9 real al inicio del número nacional
  // nunca se toca (no hay código de país detectado que dispare la regla).
  assert.equal(normalizeArgentineNationalPhone("93411234"), "93411234")
})

test("nunca deja \"0\" duplicado ni \"+540...\" (0 después de 54 también se limpia)", () => {
  assert.equal(normalizeArgentineNationalPhone("+54 0341 1234567"), "3411234567")
  assert.equal(normalizeArgentineNationalPhone("003411234567"), "3411234567")
})

test("8. teléfonos ya guardados con formatos históricos distintos convergen al mismo canónico", () => {
  const historicos = [
    "3411234567",
    "341 1234567",
    "0341 1234567",
    "+54 341 1234567",
    "+54 9 341 1234567",
    "(0341) 123-4567",
  ]

  for (const value of historicos) {
    assert.equal(normalizeArgentineNationalPhone(value), "3411234567", `falló para "${value}"`)
  }
})

test("nunca escribe +54 en el valor devuelto -- el prefijo es sólo visual", () => {
  const inputs = ["3411234567", "+54 3411234567", "0341 1234567", "+54 9 3411234567"]
  for (const value of inputs) {
    assert.doesNotMatch(normalizeArgentineNationalPhone(value), /54/)
  }
})

test("letras y basura no numérica se descartan sin romper", () => {
  assert.equal(normalizeArgentineNationalPhone("341-abc-1234567"), "3411234567")
  assert.equal(normalizeArgentineNationalPhone(""), "")
  assert.equal(normalizeArgentineNationalPhone(null), "")
  assert.equal(normalizeArgentineNationalPhone(undefined), "")
})

test("largo excesivo se recorta al máximo, nunca crece sin límite", () => {
  const muyLargo = "1".repeat(40)
  const result = normalizeArgentineNationalPhone(muyLargo)
  assert.ok(result.length <= ARGENTINA_NATIONAL_PHONE_MAX_LENGTH)
})

test("isValidArgentineNationalPhone: acepta el rango 8-11 dígitos, rechaza corto/largo/no numérico", () => {
  assert.equal(isValidArgentineNationalPhone("3411234567"), true) // 10
  assert.equal(isValidArgentineNationalPhone("11123456"), true) // 8 (mínimo)
  assert.equal(isValidArgentineNationalPhone("1234567"), false) // 7 (muy corto)
  assert.equal(isValidArgentineNationalPhone("123456789012"), false) // 12 (muy largo)
  assert.equal(isValidArgentineNationalPhone("341123456a"), false)
  assert.equal(isValidArgentineNationalPhone(""), false)
})

test("formatArgentinePhoneForDisplay antepone +54 sólo para mostrar, nunca para guardar", () => {
  assert.equal(formatArgentinePhoneForDisplay("3411234567"), "+54 3411234567")
  assert.equal(ARGENTINA_PHONE_PREFIX, "+54")
})

// --- Compatibilidad con consumidores existentes (auditoría) ---

test("compatibilidad con Andreani (lib/andreani/order-shipment.ts normalizePhoneNumber): sólo exige dígitos puros y 8-15 de largo -- el canónico siempre cumple ambas cosas", () => {
  const casosReales = [
    "3411234567",
    "+54 341 1234567",
    "0341 1234567",
    "11123456",
  ]

  for (const value of casosReales) {
    const canonical = normalizeArgentineNationalPhone(value)
    assert.match(canonical, /^\d+$/, `debe ser sólo dígitos: "${canonical}"`)
    assert.ok(canonical.length >= 8 && canonical.length <= 15, `debe estar dentro del rango de Andreani: "${canonical}"`)
  }
})

test("compatibilidad con el bloqueo de clientes (lib/clients/client-blocking.ts normalizeBlockIdentifier + public.normalize_block_identifier en SQL): ambos sólo hacen strip de no-dígitos, igual que el canónico -- nunca queda un \"54\"/\"0\" que rompa el match", () => {
  const normalizeBlockIdentifierPhone = (value: string) => value.trim().toLowerCase().replace(/\D/g, "")

  const nuevo = normalizeArgentineNationalPhone("+54 341 1234567")
  const viejoSinPrefijo = "3411234567"

  assert.equal(normalizeBlockIdentifierPhone(nuevo), normalizeBlockIdentifierPhone(viejoSinPrefijo))
})

test("el mínimo/máximo configurados son coherentes entre sí", () => {
  assert.ok(ARGENTINA_NATIONAL_PHONE_MIN_LENGTH < ARGENTINA_NATIONAL_PHONE_MAX_LENGTH)
})
