import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const ROUTE = readFileSync(
  "app/api/auth/reset-password/confirm/route.ts",
  "utf8",
)

test("el chequeo de sesión de RECUPERACIÓN corre antes de tocar la contraseña", () => {
  const amrCheckIndex = ROUTE.indexOf("isRecoverySessionToken(accessToken)")
  const updateIndex = ROUTE.indexOf("admin.auth.admin.updateUserById(")

  assert.ok(amrCheckIndex >= 0, "falta el chequeo de amr/recovery")
  assert.ok(updateIndex > amrCheckIndex, "la contraseña se actualiza antes de validar que la sesión es de recuperación")
})

test("la contraseña se revalida server-side con la MISMA política centralizada (validatePassword)", () => {
  assert.match(ROUTE, /import \{ validatePassword \}/)
  assert.match(ROUTE, /validatePassword\(password\)/)
})

test("tras cambiar la contraseña, se cierran las demás sesiones del usuario (signOut scope 'others')", () => {
  const updateIndex = ROUTE.indexOf("admin.auth.admin.updateUserById(")
  const signOutIndex = ROUTE.indexOf('admin.auth.admin.signOut(accessToken, "others")')

  assert.ok(signOutIndex > updateIndex, "signOut(others) debe ocurrir DESPUÉS de confirmar el cambio de contraseña")
})

test("un fallo al cerrar otras sesiones no aborta la respuesta: la contraseña ya cambió, es la operación crítica", () => {
  const signOutIndex = ROUTE.indexOf('admin.auth.admin.signOut(accessToken, "others")')
  const nextOkIndex = ROUTE.indexOf("ok: true", signOutIndex)

  assert.ok(signOutIndex >= 0)
  assert.ok(nextOkIndex > signOutIndex)
  // Encerrado en su propio try/catch, no en el try/catch general de la ruta.
  const surrounding = ROUTE.slice(signOutIndex - 40, signOutIndex + 120)
  assert.match(surrounding, /try \{/)
})

test("la contraseña nunca se imprime en ningún console.*", () => {
  const consoleCalls = [...ROUTE.matchAll(/console\.(log|error|warn|info)\(([^)]*)\)/g)]
  assert.ok(consoleCalls.length > 0, "se esperaba al menos un console.error para observabilidad")
  for (const match of consoleCalls) {
    assert.doesNotMatch(match[2], /\bpassword\b/i)
  }
})

test("requiere Authorization: Bearer y responde con el mensaje unificado de enlace inválido cuando falta o es de otra sesión", () => {
  assert.match(ROUTE, /authorization\.startsWith\("Bearer "\)/)
  assert.match(ROUTE, /getInvalidRecoveryLinkMessage\(\)/)
})
