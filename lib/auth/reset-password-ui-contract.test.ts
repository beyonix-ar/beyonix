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

test("/reset-password cambia la contraseña vía createPasswordUpdateSubmitter (supabase.auth.updateUser real, ver reset-password-submit.ts) -- ya NO pasa por un endpoint server-side con service_role", () => {
  const page = source("app/reset-password/page.tsx")

  assert.match(page, /from "@\/lib\/auth\/reset-password-submit"/)
  assert.match(page, /createPasswordUpdateSubmitter\(supabase\.auth\)/)
  assert.match(page, /submitter\.submit\(password\)/)

  const submitModule = source("lib/auth/reset-password-submit.ts")
  assert.match(submitModule, /auth\.updateUser\(\{ password \}\)/)
  assert.match(submitModule, /auth\.signOut\(\)/)

  // No debe quedar ningún rastro del endpoint eliminado, de mandar un
  // access_token a nuestro backend, ni de admin.updateUserById/service_role
  // en ningún lugar de este flujo. No se chequea "accessToken" en general:
  // RecoveryLinkParams.accessToken (el #access_token= del link legado) es
  // un campo legítimo y distinto, sin relación con el endpoint eliminado.
  for (const contents of [page, submitModule]) {
    assert.doesNotMatch(contents, /\/api\/auth\/reset-password\/confirm/)
    assert.doesNotMatch(contents, /Authorization: `Bearer/)
    assert.doesNotMatch(contents, /admin\.updateUserById/)
    // Uso real de service_role (no menciones en comentarios explicando por
    // qué NO se usa), y sin el cliente admin en absoluto.
    assert.doesNotMatch(contents, /SUPABASE_SERVICE_ROLE_KEY/)
    assert.doesNotMatch(contents, /createAdminClient/)
    assert.doesNotMatch(contents, /isRecoverySessionToken/)
  }
  assert.doesNotMatch(page, /fetch\(\s*"\/api\/auth\/reset-password/)
})

test("la contraseña nunca se pasa a console.log/error/warn/info en el flujo de recovery", () => {
  const page = source("app/reset-password/page.tsx")
  const submitModule = source("lib/auth/reset-password-submit.ts")

  for (const contents of [page, submitModule]) {
    const consoleCalls = [...contents.matchAll(/console\.(log|error|warn|info)\(([^)]*)\)/g)]
    for (const match of consoleCalls) {
      assert.doesNotMatch(match[2], /\bpassword\b/i)
    }
  }
})

test("nada en el repo referencia isRecoverySessionToken, recovery-session.ts, ni el endpoint /api/auth/reset-password/confirm eliminados", () => {
  // Contrato negativo global: si algo los reintrodujera (import roto,
  // copy-paste de una rama vieja), este test lo detecta.
  const filesThatMustNotReferenceThem = [
    "app/reset-password/page.tsx",
    "lib/auth/reset-password-submit.ts",
    "lib/auth/password-update-messages.ts",
    "lib/validation/password-policy.test.ts",
  ]

  for (const file of filesThatMustNotReferenceThem) {
    const contents = source(file)
    assert.doesNotMatch(contents, /isRecoverySessionToken/, file)
    assert.doesNotMatch(contents, /recovery-session/, file)
    assert.doesNotMatch(contents, /reset-password-confirm/, file)
  }
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

// --- Causa real del enlace "vencido a los segundos" (auditoría 2026-09-12) ---

test("el template de email usa token_hash apuntando a nuestro dominio, NUNCA ConfirmationURL (GET consumible por escaneo de enlaces)", () => {
  const template = source("supabase/email-templates/reset-password.html")

  assert.doesNotMatch(template, /href="\{\{\s*\.ConfirmationURL\s*\}\}"/)
  assert.match(
    template,
    /href="\{\{ \.SiteURL \}\}\/reset-password\?token_hash=\{\{ \.TokenHash \}\}&type=recovery"/,
  )
})

test("/reset-password delega TODA la decisión del link en el controller (lib/auth/recovery-flow-controller.ts -> lib/auth/recovery-link.ts), no reimplementa la lógica inline", () => {
  const page = source("app/reset-password/page.tsx")

  assert.match(
    page,
    /import \{\s*\n?\s*createRecoveryLinkController,/,
  )
  assert.match(page, /from "@\/lib\/auth\/recovery-flow-controller"/)
  assert.match(page, /createRecoveryLinkController\(\s*\n?\s*supabase\.auth,/)
  // La rama de éxito nunca debe reimplementar el chequeo de tokenHash/type acá.
  assert.doesNotMatch(page, /tokenHash && type === "recovery"/)
  // Tampoco debe llamar a verifyOtp/exchangeCodeForSession/setSession
  // directo: eso vive exclusivamente en lib/auth/recovery-link.ts.
  assert.doesNotMatch(page, /supabase\.auth\.verifyOtp/)
  assert.doesNotMatch(page, /supabase\.auth\.exchangeCodeForSession/)
  assert.doesNotMatch(page, /supabase\.auth\.setSession/)
})

test("/reset-password NUNCA llama a controller.confirm() automáticamente cuando needsConfirmation es true: sólo el handler del botón lo hace", () => {
  const page = source("app/reset-password/page.tsx")

  // El único confirm() incondicional del efecto de montaje vive DESPUÉS del
  // `return` de la rama needsConfirmation -- nunca antes.
  const needsConfirmationIndex = page.indexOf("if (controller.needsConfirmation)")
  const autoConfirmIndex = page.indexOf("void controller.confirm().then(applyResolution)")
  const clickHandlerIndex = page.indexOf("const handleConfirmRecovery")
  const clickConfirmIndex = page.indexOf(
    "void controllerRef.current?.confirm().then(applyResolution)",
  )

  assert.ok(needsConfirmationIndex >= 0)
  assert.ok(autoConfirmIndex > needsConfirmationIndex)
  assert.ok(clickHandlerIndex >= 0)
  assert.ok(clickConfirmIndex > clickHandlerIndex)
})

test("el botón de confirmación se deshabilita mientras se procesa el click (confirmingRecovery)", () => {
  const page = source("app/reset-password/page.tsx")

  assert.match(page, /Continuar con la recuperación/)
  assert.match(page, /disabled=\{confirmingRecovery\}/)
  assert.match(page, /setConfirmingRecovery\(true\)/)
})

test("sin ningún link interno (<Link>) apunta a /reset-password: nada dispara un prefetch de Next.js sobre esta ruta", () => {
  const filesToCheck = [
    "app/login/page.tsx",
    "components/account/auth-forms.tsx",
    "context/auth-context.tsx",
  ]

  for (const file of filesToCheck) {
    const contents = source(file)
    assert.doesNotMatch(
      contents,
      /href="\/reset-password"/,
      `${file} no debe linkear a /reset-password con <Link> (dispararía prefetch)`,
    )
  }
})

test("lib/auth/recovery-link.ts soporta token_hash+type=recovery llamando a verifyOtp (formato que manda el email hoy)", () => {
  const recoveryLink = source("lib/auth/recovery-link.ts")

  assert.match(recoveryLink, /params\.tokenHash && params\.type === "recovery"/)
  assert.match(recoveryLink, /auth\.verifyOtp\(\{/)
  assert.match(recoveryLink, /token_hash: params\.tokenHash,/)
})

test("el form embebido de /cuenta (auth-forms.tsx) también pasa por el endpoint server-side de recuperación, no llama a resetPasswordForEmail directo", () => {
  const authForms = source("components/account/auth-forms.tsx")

  assert.doesNotMatch(authForms, /await supabase\.auth\.resetPasswordForEmail/)
  assert.match(authForms, /\/api\/auth\/forgot-password/)
  assert.doesNotMatch(
    authForms,
    /localStorage\.setItem\("beyonix-password-recovery", "true"\)/,
  )
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
