import assert from "node:assert/strict"
import test from "node:test"

import {
  deriveArgentineDni,
  isValidCuilChecksum,
  normalizeDeclaredDni,
} from "./argentine-identification.ts"

/** Construye un CUIL válido (checksum correcto) para un DNI y prefijo dados, sólo para tests. */
function buildValidCuil(prefix: string, dni: string): string {
  const first10 = `${prefix}${dni}`
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 10; i += 1) {
    sum += Number(first10[i]) * weights[i]
  }
  const mod = sum % 11
  const verifier = 11 - mod
  const checkDigit = verifier === 11 ? 0 : verifier === 10 ? 9 : verifier
  return `${first10}${checkDigit}`
}

test("isValidCuilChecksum acepta un CUIL construido con el algoritmo real de AFIP", () => {
  const cuil = buildValidCuil("20", "12345678")
  assert.equal(isValidCuilChecksum(cuil), true)
})

test("isValidCuilChecksum rechaza un dígito verificador alterado", () => {
  const cuil = buildValidCuil("20", "12345678")
  const tampered = cuil.slice(0, 10) + String((Number(cuil[10]) + 1) % 10)
  assert.equal(isValidCuilChecksum(tampered), false)
})

test("isValidCuilChecksum rechaza longitudes distintas de 11", () => {
  assert.equal(isValidCuilChecksum("123"), false)
  assert.equal(isValidCuilChecksum(""), false)
})

test("deriveArgentineDni: CUIL válido de persona física deriva el DNI del bloque central", () => {
  const cuil = buildValidCuil("20", "30111222")
  const result = deriveArgentineDni({ type: "CUIL", number: cuil })

  assert.equal(result.dni, "30111222")
  assert.equal(result.reason, null)
  assert.equal(result.normalizedNumber, cuil)
  assert.equal(result.originalType, "CUIL")
})

test("deriveArgentineDni: CUIT válido de persona física (prefijo 23) también deriva DNI", () => {
  const cuit = buildValidCuil("23", "25999888")
  const result = deriveArgentineDni({ type: "CUIT", number: cuit })

  assert.equal(result.dni, "25999888")
  assert.equal(result.reason, null)
})

test("deriveArgentineDni: CUIT de persona jurídica (prefijo 30) nunca deriva un DNI", () => {
  const cuit = buildValidCuil("30", "71234567")
  const result = deriveArgentineDni({ type: "CUIT", number: cuit })

  assert.equal(result.dni, null)
  assert.equal(result.reason, "non_person_prefix")
})

test("deriveArgentineDni: dígito verificador inválido nunca deriva un DNI (no corta a ciegas)", () => {
  const cuil = buildValidCuil("20", "30111222")
  const tampered = cuil.slice(0, 10) + String((Number(cuil[10]) + 1) % 10)
  const result = deriveArgentineDni({ type: "CUIL", number: tampered })

  assert.equal(result.dni, null)
  assert.equal(result.reason, "invalid_checksum")
})

test("deriveArgentineDni: longitud inesperada de CUIL nunca deriva un DNI", () => {
  const result = deriveArgentineDni({ type: "CUIL", number: "12345" })
  assert.equal(result.dni, null)
  assert.equal(result.reason, "unexpected_length")
})

test("deriveArgentineDni: identification.type=DNI usa el número tal cual (7-8 dígitos)", () => {
  const result = deriveArgentineDni({ type: "DNI", number: "30.111.222" })
  assert.equal(result.dni, "30111222")
  assert.equal(result.normalizedNumber, "30111222")
})

test("deriveArgentineDni: DNI con longitud inválida no deriva nada", () => {
  const result = deriveArgentineDni({ type: "DNI", number: "123" })
  assert.equal(result.dni, null)
  assert.equal(result.reason, "unexpected_length")
})

test("deriveArgentineDni: tipo de identificación no soportado (ej. pasaporte) nunca deriva un DNI", () => {
  const result = deriveArgentineDni({ type: "PASSPORT", number: "AB123456" })
  assert.equal(result.dni, null)
  assert.equal(result.reason, "unsupported_identification_type")
})

test("deriveArgentineDni: identification ausente (caso real de Mercado Pago) nunca deriva un DNI", () => {
  const result = deriveArgentineDni({ type: null, number: null })
  assert.equal(result.dni, null)
  assert.equal(result.reason, "missing_identification")
  assert.equal(result.originalType, null)
})

test("deriveArgentineDni conserva siempre el tipo y número original sin sobrescribirlos", () => {
  const cuil = buildValidCuil("27", "40555666")
  const result = deriveArgentineDni({ type: "cuil", number: ` ${cuil} ` })

  assert.equal(result.originalType, "cuil")
  assert.equal(result.originalNumber, cuil)
  assert.equal(result.dni, "40555666")
})

test("normalizeDeclaredDni acepta 7 u 8 dígitos con separadores", () => {
  assert.equal(normalizeDeclaredDni("30.111.222"), "30111222")
  assert.equal(normalizeDeclaredDni("5123456"), "5123456")
})

test("normalizeDeclaredDni rechaza longitudes inválidas o valores vacíos", () => {
  assert.equal(normalizeDeclaredDni("123"), null)
  assert.equal(normalizeDeclaredDni(""), null)
  assert.equal(normalizeDeclaredDni(null), null)
  assert.equal(normalizeDeclaredDni(undefined), null)
})
