import assert from "node:assert/strict"
import test from "node:test"

import {
  FIELD_LIMITS,
  getPasswordRequirements,
  meetsPasswordRequirements,
  validatePassword,
} from "./account-fields.ts"

/**
 * Política de contraseña centralizada -- la misma usada en registro, en el
 * formulario de /reset-password Y en el endpoint server-side
 * app/api/auth/reset-password/confirm (validatePassword). Un solo lugar,
 * probado acá, para que ningún flujo termine con reglas inconsistentes.
 */

test("contraseña que cumple los 4 requisitos (8+, mayúscula, minúscula, número) es válida", () => {
  assert.equal(validatePassword("Beyonix1"), "")
  assert.equal(meetsPasswordRequirements("Beyonix1"), true)
})

test("contraseña que NO cumple los requisitos: cada regla faltante da un mensaje específico", () => {
  assert.match(validatePassword("corta1A"), /al menos 8 caracteres/)
  assert.match(validatePassword("minuscula1"), /al menos una mayúscula/)
  assert.match(validatePassword("MAYUSCULA1"), /al menos una minúscula/)
  assert.match(validatePassword("SinNumero"), /al menos un número/)
})

test("contraseña que no cumple requisitos: meetsPasswordRequirements también la rechaza (misma fuente de verdad)", () => {
  assert.equal(meetsPasswordRequirements("sinnumero"), false)
  assert.equal(meetsPasswordRequirements("corta1A"), false)
})

test("límite superior de longitud: se respeta FIELD_LIMITS.password, ni una más", () => {
  const maxValid = "A1".padEnd(FIELD_LIMITS.password, "a")
  const tooLong = `${maxValid}x`

  assert.equal(maxValid.length, FIELD_LIMITS.password)
  assert.equal(validatePassword(maxValid), "")
  assert.match(validatePassword(tooLong), /no puede superar los 20 caracteres/)
  assert.equal(meetsPasswordRequirements(tooLong), false)
})

test("getPasswordRequirements refleja en tiempo real cada requisito de forma independiente", () => {
  const requirements = getPasswordRequirements("Ab1")
  const byLabel = Object.fromEntries(requirements.map((r) => [r.label, r.met]))

  assert.equal(byLabel["Mínimo 8 caracteres"], false)
  assert.equal(byLabel["Una letra mayúscula"], true)
  assert.equal(byLabel["Una letra minúscula"], true)
  assert.equal(byLabel["Un número"], true)
})

test("contraseña vacía: todos los requisitos aparecen como no cumplidos, sin lanzar", () => {
  const requirements = getPasswordRequirements("")
  assert.ok(requirements.every((r) => r.met === false))
  assert.match(validatePassword(""), /al menos 8 caracteres/)
})

test("acentos/ñ en la contraseña no rompen la detección de mayúscula/minúscula (unicode-aware)", () => {
  assert.equal(validatePassword("Contraseña1"), "")
})
