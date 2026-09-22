import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const SOURCE = readFileSync("components/account/profile-sections.tsx", "utf8")

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

const CHANGE_PASSWORD_FORM = extractFunction("ChangePasswordForm")

// Cambio de negocio 2026-09: el formulario ya NO pide ni valida la
// contraseña actual -- sólo nueva contraseña + confirmación. El flujo
// correcto de Supabase Auth para un usuario ya autenticado es
// updateUser({password}) directo sobre la sesión activa (GoTrue la exige y
// la valida; rechaza la llamada sin sesión válida), sin re-autenticar con
// signInWithPassword ni reenviar current_password.

test("ChangePasswordForm ya no tiene campo, estado ni verificación de contraseña actual", () => {
  assert.doesNotMatch(CHANGE_PASSWORD_FORM, /currentPassword/)
  assert.doesNotMatch(CHANGE_PASSWORD_FORM, /signInWithPassword\(/)
  assert.doesNotMatch(CHANGE_PASSWORD_FORM, /label="Contraseña actual"/)
})

test("el cambio de contraseña llama a updateUser() con la nueva contraseña, sin current_password", () => {
  const updateUserIndex = CHANGE_PASSWORD_FORM.indexOf("supabase.auth.updateUser({")
  assert.ok(updateUserIndex >= 0)
  const updateUserCall = CHANGE_PASSWORD_FORM.slice(updateUserIndex, updateUserIndex + 400)
  assert.match(updateUserCall, /password: newPassword,/)
  assert.doesNotMatch(updateUserCall, /current_password/)
})

test("los requisitos de contraseña se validan en vivo reutilizando el mismo helper/componente de Registrarse (meetsPasswordRequirements + PasswordRequirements)", () => {
  assert.match(CHANGE_PASSWORD_FORM, /meetsPasswordRequirements\(newPassword\)/)
  assert.match(CHANGE_PASSWORD_FORM, /<PasswordRequirements password=\{newPassword\} \/>/)
  assert.match(SOURCE, /from "@\/components\/password-requirements"/)
})

test("la confirmación de contraseña muestra un estado visual claro de coincidencia/no coincidencia", () => {
  assert.match(CHANGE_PASSWORD_FORM, /passwordsMatch = confirmHasValue && newPassword === confirmPassword/)
  assert.match(CHANGE_PASSWORD_FORM, /passwordsMismatch = confirmHasValue && newPassword !== confirmPassword/)
  assert.match(CHANGE_PASSWORD_FORM, /success=\{passwordsMatch\}/)
  assert.match(CHANGE_PASSWORD_FORM, /error=\{passwordsMismatch \? "Las contraseñas no coinciden\." : undefined\}/)
})

test("el botón de submit queda deshabilitado hasta que la contraseña sea válida y coincida, y muestra loading durante el request", () => {
  assert.match(CHANGE_PASSWORD_FORM, /const canSubmit = isPasswordValid && passwordsMatch/)
  assert.match(CHANGE_PASSWORD_FORM, /disabled=\{loading \|\| !canSubmit\}/)
})

test("doble submit: un gate síncrono (ref) impide una segunda ejecución concurrente, y se libera SIEMPRE en un finally (no queda trabado tras un error)", () => {
  assert.match(CHANGE_PASSWORD_FORM, /const submittingRef = useRef\(false\)/)
  assert.match(CHANGE_PASSWORD_FORM, /if \(submittingRef\.current\) return\s*\n\s*submittingRef\.current = true/)

  const tryIndex = CHANGE_PASSWORD_FORM.indexOf("try {")
  const finallyIndex = CHANGE_PASSWORD_FORM.indexOf("} finally {")
  assert.ok(tryIndex >= 0 && finallyIndex > tryIndex, "el cuerpo debe estar en un try/finally")

  const finallyBlock = CHANGE_PASSWORD_FORM.slice(finallyIndex, finallyIndex + 400)
  assert.match(finallyBlock, /submittingRef\.current = false/)
})

test("tras un cambio de contraseña EXITOSO, cierra las otras sesiones (signOut scope others) -- nunca antes de confirmar el updateUser", () => {
  const updateUserIndex = CHANGE_PASSWORD_FORM.indexOf("supabase.auth.updateUser({")
  const updateErrorCheckIndex = CHANGE_PASSWORD_FORM.indexOf("if (updateError)", updateUserIndex)
  const signOutIndex = CHANGE_PASSWORD_FORM.indexOf('signOut({ scope: "others" })')

  assert.ok(signOutIndex > updateErrorCheckIndex, "signOut(others) debe ocurrir DESPUÉS de confirmar que updateUser no falló")
})

test("un error al actualizar la contraseña NUNCA cierra otras sesiones (return temprano antes del signOut)", () => {
  const updateUserIndex = CHANGE_PASSWORD_FORM.indexOf("supabase.auth.updateUser({")
  const updateErrorBlockIndex = CHANGE_PASSWORD_FORM.indexOf("if (updateError) {", updateUserIndex)
  const updateErrorReturnIndex = CHANGE_PASSWORD_FORM.indexOf("return", updateErrorBlockIndex)
  const signOutIndex = CHANGE_PASSWORD_FORM.indexOf('signOut({ scope: "others" })')

  assert.ok(updateErrorReturnIndex > 0 && updateErrorReturnIndex < signOutIndex)
})

test("el cooldown de 15 días usa una fecha propia (last_password_change_at en user_metadata), separada de la sesión de recovery", () => {
  assert.match(SOURCE, /PASSWORD_CHANGE_COOLDOWN_DAYS = 15/)
  assert.match(CHANGE_PASSWORD_FORM, /last_password_change_at/)

  // El flujo de recovery (lib/auth/reset-password-submit.ts) NO debe escribir
  // este mismo campo -- si lo hiciera, completar un recovery bloquearía (o
  // resetearía) el cooldown del cambio voluntario, que son flujos distintos.
  const recoverySubmitSource = readFileSync("lib/auth/reset-password-submit.ts", "utf8")
  assert.doesNotMatch(recoverySubmitSource, /last_password_change_at/)
})
