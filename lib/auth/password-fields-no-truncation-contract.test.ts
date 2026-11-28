import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Ningún campo de contraseña (login, registro, confirmación, recuperación,
// cambio desde el perfil ni el login de /cuenta) puede tener maxLength: el
// navegador recorta en silencio lo tipeado, pegado o autocompletado. El
// límite real de las contraseñas NUEVAS se valida con un mensaje
// (validatePassword), y el login no valida nada de la contraseña.

const FILES = [
  "app/login/page.tsx",
  "app/reset-password/page.tsx",
  "components/account/auth-forms.tsx",
  "components/account/profile-sections.tsx",
]

/** Cada elemento JSX (<Field ... /> / <InputField ... /> / <input ... />) que sea de contraseña. */
function passwordElements(source: string) {
  const elements: string[] = []
  const pattern = /<(Field|InputField|input)\b[\s\S]*?\/>/g
  for (const match of source.matchAll(pattern)) {
    const element = match[0]
    if (/type=\{?["']?password|type=\{show\w*\s*\?\s*"text"\s*:\s*"password"\}|autoComplete="(new|current)-password"|label="(Nueva |Confirmar )?[Cc]ontraseña/.test(element)) {
      elements.push(element)
    }
  }
  return elements
}

for (const file of FILES) {
  test(`${file}: ningún campo de contraseña tiene maxLength`, () => {
    const source = readFileSync(file, "utf8")
    const elements = passwordElements(source)
    assert.ok(elements.length > 0, "se encontraron los campos de contraseña")
    for (const element of elements) assert.doesNotMatch(element, /maxLength/, element.slice(0, 160))
    assert.doesNotMatch(source, /FIELD_LIMITS\.password/)
  })
}

test("el login no aplica reglas de creación: sólo envía identificador y contraseña", () => {
  const page = readFileSync("app/login/page.tsx", "utf8").replace(/\r\n/g, "\n")
  const loginBranch = page.slice(page.indexOf('if (mode === "login") {'), page.indexOf("const passwordError = validatePassword(password)"))
  assert.match(loginBranch, /await login\(identifier, password\)/)
  assert.doesNotMatch(loginBranch, /validatePassword|meetsPasswordRequirements|trim\(\)|normalize\(/)
  const login = readFileSync("lib/auth/login.ts", "utf8")
  assert.match(login, /const password = typeof passwordRaw === "string" \? passwordRaw : ""/)
  assert.doesNotMatch(login, /validatePassword|meetsPasswordRequirements|password\.trim|password\.normalize/)
  const context = readFileSync("context/auth-context.tsx", "utf8")
  assert.match(context, /body: JSON\.stringify\(\{ identifier, password \}\)/)
})

test("recuperación y cambio de contraseña validan con la política central (mensaje, nunca recorte)", () => {
  assert.match(readFileSync("app/reset-password/page.tsx", "utf8"), /const passwordError = validatePassword\(password\)/)
  assert.match(readFileSync("components/account/profile-sections.tsx", "utf8"), /const passwordError = validatePassword\(newPassword\)/)
})
