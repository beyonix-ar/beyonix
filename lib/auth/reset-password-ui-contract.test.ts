import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function source(path: string) {
  return readFileSync(path, "utf8")
}

test("/reset-password usa el navbar canónico real (SiteHeader), no una copia manual", () => {
  const layoutShell = source("components/layout-shell.tsx")

  const passwordResetBranch = layoutShell.indexOf("if (isPasswordReset)")
  const authPageBranch = layoutShell.indexOf("if (isAuthPage)")

  assert.ok(passwordResetBranch >= 0)
  assert.ok(authPageBranch > passwordResetBranch)

  const branchBody = layoutShell.slice(passwordResetBranch, authPageBranch)
  assert.match(branchBody, /<SiteHeader \/>/)

  // El propio archivo de la página nunca debe recrear un <header>/<nav> a
  // mano: el navbar tiene que venir de afuera (LayoutShell), no duplicado.
  const page = source("app/reset-password/page.tsx")
  assert.doesNotMatch(page, /<header/i)
  assert.doesNotMatch(page, /<nav\b/i)
  assert.doesNotMatch(page, /BeyonixLogoLink/)
})

test("/reset-password reutiliza los componentes/tokens de diseño existentes, no estilos paralelos", () => {
  const page = source("app/reset-password/page.tsx")

  assert.match(page, /from "@\/components\/beyonix-ui"/)
  assert.match(page, /BeyonixCard/)
  assert.match(page, /BeyonixButton/)
  assert.match(page, /BeyonixIconBox/)
  assert.match(page, /from "@\/components\/password-requirements"/)
  assert.match(page, /<PasswordRequirements password=\{password\} \/>/)
})

test("/reset-password nunca llama a supabase.auth.updateUser directo: el cambio de contraseña pasa por el endpoint server-side", () => {
  const page = source("app/reset-password/page.tsx")

  assert.doesNotMatch(page, /supabase\.auth\.updateUser/)
  assert.match(page, /\/api\/auth\/reset-password\/confirm/)
  assert.match(page, /Authorization: `Bearer \$\{accessToken\}`/)
})

test("estado de enlace inválido/expirado: mensaje claro + botón para pedir uno nuevo, sin continuar en silencio", () => {
  const page = source("app/reset-password/page.tsx")

  assert.match(page, /getInvalidRecoveryLinkMessage/)
  assert.match(page, /Solicitar un nuevo enlace/)
})

test("estado de éxito: copy exacto pedido y botón explícito 'Iniciar sesión' (no redirect automático silencioso)", () => {
  const page = source("app/reset-password/page.tsx")

  assert.match(page, /Contraseña actualizada/)
  assert.match(page, /Ya podés iniciar sesión con tu nueva contraseña\./)
  assert.match(page, /href="\/login" aria-label="Iniciar sesión"/)
})

test("el login reutiliza el MISMO campo identifier para \"olvidé mi contraseña\" (username o email), sin duplicar UI", () => {
  const login = source("app/login/page.tsx")

  const handlerIndex = login.indexOf("const handleForgotPassword = async () => {")
  assert.ok(handlerIndex >= 0)
  const handlerBody = login.slice(handlerIndex, handlerIndex + 1500)

  // Ya no exige "@" en el identificador: acepta username o email por igual.
  assert.doesNotMatch(handlerBody, /includes\("@"\)/)
  assert.match(handlerBody, /\/api\/auth\/forgot-password/)
  assert.match(handlerBody, /identifier: recoveryIdentifier/)
})

// --- Contraste del cartel de "olvidé mi contraseña" (reporte real de usuario) ---

test("las alertas de error/éxito del login usan los tokens semánticos --account-danger-*/--account-success-* (contraste correcto en ambos temas), no emerald/red planos", () => {
  const login = source("app/login/page.tsx")

  assert.match(login, /border-\[var\(--account-danger-border\)\]/)
  assert.match(login, /bg-\[var\(--account-danger-bg\)\]/)
  assert.match(login, /text-\[var\(--account-danger-text\)\]/)
  assert.match(login, /border-\[var\(--account-success-border\)\]/)
  assert.match(login, /bg-\[var\(--account-success-bg\)\]/)
  assert.match(login, /text-\[var\(--account-success-text\)\]/)

  // Ya no quedan los tonos planos de baja opacidad que casi no se leían.
  assert.doesNotMatch(login, /border-emerald-500\/20 bg-emerald-500\/10/)
  assert.doesNotMatch(login, /border-red-500\/20 bg-red-500\/10/)
})

test("los tokens --account-success-*/--account-danger-* tienen valores distintos (y por lo tanto contraste real) en Light y Dark", () => {
  const css = source("app/globals.css")

  const darkRoot = css.slice(css.indexOf(":root {"), css.indexOf("html[data-account-theme=\"light\"]"))
  const lightRoot = css.slice(css.indexOf("html[data-account-theme=\"light\"][data-account-scope] {"))

  const darkSuccessText = /--account-success-text:\s*([^;]+);/.exec(darkRoot)?.[1]
  const lightSuccessText = /--account-success-text:\s*([^;]+);/.exec(lightRoot)?.[1]

  assert.ok(darkSuccessText && lightSuccessText)
  assert.notEqual(darkSuccessText, lightSuccessText)
  // Dark: texto claro sobre fondo oscuro. Light: texto oscuro sobre fondo claro.
  assert.match(darkSuccessText, /#d1fae5/i)
  assert.match(lightSuccessText, /#065f46/i)
})

test("\"olvidé mi contraseña\" muestra un cartel propio con ícono + título neutro \"Revisá tu correo\" (nunca confirma que la cuenta existe)", () => {
  const login = source("app/login/page.tsx")

  assert.match(login, /forgotPasswordMessage/)
  assert.match(login, /MailCheck/)
  assert.match(login, /Revisá tu correo/)

  // Este cartel es un estado propio, distinto del `success` genérico
  // (compartido con "cuenta creada"/"email confirmado"): no debe pisarlo ni
  // reusar su texto para otros flujos.
  const forgotHandlerIndex = login.indexOf("const handleForgotPassword = async () => {")
  const handlerBody = login.slice(forgotHandlerIndex, forgotHandlerIndex + 1500)
  assert.doesNotMatch(handlerBody, /setSuccess\(data\?\.message/)
  assert.match(handlerBody, /setForgotPasswordMessage\(data\?\.message/)
})
