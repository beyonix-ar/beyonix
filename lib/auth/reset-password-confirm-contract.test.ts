import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const ROUTE = readFileSync(
  "app/api/auth/reset-password/confirm/route.ts",
  "utf8",
)

// La lógica real vive en lib/auth/reset-password-confirm.ts (ver
// reset-password-confirm.test.ts para la cobertura de comportamiento real);
// esta ruta es un wrapper delgado que sólo parsea el request y delega.

test("la ruta delega la lógica de cambio de contraseña en confirmPasswordReset, no la reimplementa", () => {
  assert.match(ROUTE, /import \{ confirmPasswordReset \} from "@\/lib\/auth\/reset-password-confirm"/)
  assert.match(ROUTE, /confirmPasswordReset\(\{/)

  // No debe haber lógica de negocio duplicada acá: sin admin.auth.admin.*
  // directo en la ruta, todo pasa por la función extraída.
  assert.doesNotMatch(ROUTE, /admin\.auth\.admin\.updateUserById/)
  assert.doesNotMatch(ROUTE, /admin\.auth\.admin\.signOut/)
  assert.doesNotMatch(ROUTE, /isRecoverySessionToken/)
})

test("el access_token se extrae del header Authorization: Bearer y se pasa tal cual a confirmPasswordReset", () => {
  const handlerIndex = ROUTE.indexOf("export async function POST")
  const delegateIndex = ROUTE.indexOf("confirmPasswordReset({")
  const body = ROUTE.slice(handlerIndex, delegateIndex + 400)

  assert.match(body, /authorization\.startsWith\("Bearer "\)/)
  assert.match(body, /accessToken,/)
  assert.match(body, /passwordRaw: body\?\.password,/)
})

test("un error de confirmPasswordReset se traduce 1:1 al status/error de la respuesta HTTP", () => {
  assert.match(ROUTE, /if \(!result\.ok\)/)
  assert.match(ROUTE, /status: result\.status/)
  assert.match(ROUTE, /error: result\.error/)
})
