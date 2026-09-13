import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const SOURCE = readFileSync("components/account/auth-forms.tsx", "utf8")

function extractFunction(name: string) {
  const start = SOURCE.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `no se encontró function ${name}(`)
  // Corta en la siguiente declaración de función de nivel superior (con o
  // sin "export"), o al final del archivo.
  const nextPlain = SOURCE.indexOf("\nfunction ", start + 1)
  const nextExport = SOURCE.indexOf("\nexport function ", start + 1)
  const candidates = [nextPlain, nextExport].filter((i) => i !== -1)
  const next = candidates.length ? Math.min(...candidates) : -1
  return next === -1 ? SOURCE.slice(start) : SOURCE.slice(start, next)
}

const REGISTER_FORM = extractFunction("RegisterForm")

// --- Bug real reportado 2026-09-14: el popup de autocompletado de Chrome/
// Google Password Manager se ancla debajo del input de contraseña al
// enfocarlo y tapaba el bloque "Requisitos de contraseña" cuando éste
// quedaba DESPUÉS del campo -- el usuario no podía leer los requisitos
// mientras escribía. Se corrige mostrando los requisitos ANTES del campo,
// sin intentar desactivar el password manager del navegador (no es algo
// controlable desde la página).

test("RegisterForm: el bloque de requisitos de contraseña se muestra ANTES del InputField de Contraseña (no queda tapado por el popup de Chrome)", () => {
  const requirementsIndex = REGISTER_FORM.indexOf(
    "<PasswordRequirements password={password} />",
  )
  const passwordFieldIndex = REGISTER_FORM.indexOf('label="Contraseña"')

  assert.ok(requirementsIndex >= 0, "falta <PasswordRequirements />")
  assert.ok(passwordFieldIndex >= 0, "falta el InputField de Contraseña")
  assert.ok(
    requirementsIndex < passwordFieldIndex,
    "PasswordRequirements debe renderizarse antes del campo de contraseña",
  )
})

test("RegisterForm: sigue habiendo un único bloque de requisitos (no se duplicó al reubicarlo)", () => {
  const occurrences = [
    ...REGISTER_FORM.matchAll(/<PasswordRequirements password=\{password\} \/>/g),
  ]
  assert.equal(occurrences.length, 1)
})

test("PasswordRequirements conserva validación en tiempo real y checks cumplidos/no cumplidos (no se tocaron las reglas reales de contraseña)", () => {
  const componentSource = readFileSync("components/password-requirements.tsx", "utf8")

  assert.match(componentSource, /getPasswordRequirements\(password\)/)
  assert.match(componentSource, /requirement\.met/)
})
