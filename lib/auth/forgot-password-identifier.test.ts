import assert from "node:assert/strict"
import test from "node:test"

import { normalizeForgotPasswordIdentifier } from "./forgot-password-identifier.ts"

test("un email válido se clasifica como email y se normaliza a minúsculas", () => {
  assert.deepEqual(
    normalizeForgotPasswordIdentifier("  Cliente@Example.COM  "),
    { kind: "email", value: "cliente@example.com" },
  )
})

test("un username válido (ej. ANTARES) se clasifica como username, normalizado a minúsculas", () => {
  assert.deepEqual(normalizeForgotPasswordIdentifier("ANTARES"), {
    kind: "username",
    value: "antares",
  })
})

test("input vacío o sólo espacios se rechaza (formato, no existencia)", () => {
  assert.equal(normalizeForgotPasswordIdentifier(""), null)
  assert.equal(normalizeForgotPasswordIdentifier("   "), null)
})

test("identificador con espacios internos se rechaza (ni email ni username real tienen espacios)", () => {
  assert.equal(normalizeForgotPasswordIdentifier("usuario con espacio"), null)
  assert.equal(normalizeForgotPasswordIdentifier("no es un email @ raro"), null)
})

test("un email con forma inválida se rechaza sin intentar tratarlo como username", () => {
  assert.equal(normalizeForgotPasswordIdentifier("no-arroba-punto@"), null)
  assert.equal(normalizeForgotPasswordIdentifier("@sinusuario.com"), null)
})

test("tipos no-string y valores undefined/null nunca pasan", () => {
  assert.equal(normalizeForgotPasswordIdentifier(undefined), null)
  assert.equal(normalizeForgotPasswordIdentifier(null), null)
  assert.equal(normalizeForgotPasswordIdentifier(42), null)
  assert.equal(normalizeForgotPasswordIdentifier({ email: "x@x.com" }), null)
})

test("longitudes excesivas se rechazan por formato (mismo límite que el resto del sitio)", () => {
  const longUsername = "a".repeat(19) // FIELD_LIMITS.username = 18
  const longEmail = `${"a".repeat(115)}@x.com` // > FIELD_LIMITS.email = 120

  assert.equal(normalizeForgotPasswordIdentifier(longUsername), null)
  assert.equal(normalizeForgotPasswordIdentifier(longEmail), null)
})

test("un username en el límite exacto (18 caracteres) sigue siendo válido", () => {
  const username = "a".repeat(18)
  assert.deepEqual(normalizeForgotPasswordIdentifier(username), {
    kind: "username",
    value: username,
  })
})
