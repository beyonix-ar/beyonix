import assert from "node:assert/strict"
import test from "node:test"

import {
  FIELD_LIMITS,
  PASSWORD_MAX_BYTES,
  getPasswordByteLength,
  getPasswordRequirements,
  meetsPasswordRequirements,
  validatePassword,
} from "./account-fields.ts"

/**
 * Política de contraseña centralizada -- la misma usada en registro y en el
 * formulario de /reset-password (validatePassword antes de llamar a
 * supabase.auth.updateUser()). Un solo lugar, probado acá, para que ningún
 * flujo termine con reglas inconsistentes.
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

test("límite superior real: 72 bytes UTF-8 (bcrypt de Supabase Auth), ni uno más; ya no el arbitrario 20", () => {
  const maxValid = "A1".padEnd(PASSWORD_MAX_BYTES, "a")
  const tooLong = `${maxValid}x`

  assert.equal(PASSWORD_MAX_BYTES, 72)
  assert.equal(getPasswordByteLength(maxValid), 72)
  assert.equal(validatePassword(maxValid), "")
  assert.equal(meetsPasswordRequirements(maxValid), true)
  assert.match(validatePassword(tooLong), /demasiado larga: admite hasta 72 caracteres/)
  assert.equal(meetsPasswordRequirements(tooLong), false)
  // El panel de requisitos lo explica sólo cuando se excede.
  assert.deepEqual(getPasswordRequirements(tooLong).filter((r) => !r.met).map((r) => r.label), ["Hasta 72 caracteres"])
  assert.equal(getPasswordRequirements(maxValid).length, 4)
})

test("contraseñas nuevas de 21, 24 y 64 caracteres (gestores) son válidas", () => {
  for (const password of ["Ficticia-2026-Clave12", "Ficticia-2026-Clave12345", "q7#Vt9!xR2$wLm8@Zp4^Hs6&Ky1*Nb3(Jd5)Fg0_Uc2+Ea7=Wr9{Ti4}Ol6|Ms8?"]) {
    assert.equal(validatePassword(password), "", password)
    assert.equal(meetsPasswordRequirements(password), true, password)
  }
})

test("el límite se mide en bytes: caracteres multibyte cuentan más de uno, sin recortar nada", () => {
  const ascii71 = "A1".padEnd(71, "a")
  assert.equal(validatePassword(`${ascii71}b`), "", "72 bytes")
  assert.match(validatePassword(`${ascii71}ñ`), /demasiado larga/, "la ñ ocupa 2 bytes: 73")
  assert.equal(getPasswordByteLength("🔐"), 4)
})

test("espacios y símbolos se aceptan tal cual en contraseñas nuevas (sin trim)", () => {
  assert.equal(validatePassword("  Clave Segura 9  "), "")
  assert.equal(validatePassword("Ab1!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"), "")
})

test("FIELD_LIMITS ya no tiene un máximo de contraseña reutilizable por el login", () => {
  assert.equal("password" in FIELD_LIMITS, false)
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
