import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function source(path: string) {
  return readFileSync(path, "utf8")
}

// --- Corrección 2026-09-12: /confirmar-email llamaba a verifyOtp/
// exchangeCodeForSession automáticamente en el useEffect de montaje, sin
// esperar un click humano -- mismo problema (parcial) que se había
// corregido antes en /reset-password: un GET/render que sí ejecuta JS (link
// preview con headless browser, algunos gateways corporativos, unfurling de
// Slack/Teams) consumía el token de signup sin que el usuario hiciera nada.

test("/confirmar-email delega TODA la decisión del link en el controller (lib/auth/confirmation-flow-controller.ts -> lib/auth/confirmation-link.ts), no reimplementa la lógica inline", () => {
  const page = source("app/confirmar-email/page.tsx")

  assert.match(page, /createConfirmationLinkController/)
  assert.match(page, /from "@\/lib\/auth\/confirmation-flow-controller"/)
  assert.match(page, /createConfirmationLinkController\(supabase\.auth, params\)/)

  // No debe llamar a verifyOtp/exchangeCodeForSession directo: eso vive
  // exclusivamente en lib/auth/confirmation-link.ts.
  assert.doesNotMatch(page, /supabase\.auth\.verifyOtp/)
  assert.doesNotMatch(page, /supabase\.auth\.exchangeCodeForSession/)
})

test("/confirmar-email NUNCA llama a controller.confirm() automáticamente cuando needsConfirmation es true: sólo el handler del botón lo hace", () => {
  const page = source("app/confirmar-email/page.tsx")

  const needsConfirmationIndex = page.indexOf("if (controller.needsConfirmation)")
  const clickHandlerIndex = page.indexOf("const handleConfirmClick")
  const clickConfirmIndex = page.indexOf(
    "void controllerRef.current.confirm().then(finishConfirmation)",
  )

  assert.ok(needsConfirmationIndex >= 0)
  assert.ok(clickHandlerIndex >= 0)
  assert.ok(clickConfirmIndex > clickHandlerIndex)

  // El bloque del efecto de montaje, entre needsConfirmation y el cierre del
  // useEffect, nunca debe invocar confirm() incondicionalmente -- sólo
  // setear needsConfirmation/error según corresponda.
  const effectEnd = page.indexOf("}, [router, searchParams])")
  const mountEffectBody = page.slice(needsConfirmationIndex, effectEnd)
  assert.doesNotMatch(mountEffectBody, /controller\.confirm\(\)/)
})

test("hay un botón visible \"Confirmar mi cuenta\" que se deshabilita mientras se procesa el click (confirming)", () => {
  const page = source("app/confirmar-email/page.tsx")

  assert.match(page, /Confirmar mi cuenta/)
  assert.match(page, /onClick=\{handleConfirmClick\}/)
  assert.match(page, /disabled=\{confirming\}/)
  assert.match(page, /setConfirming\(true\)/)
})

test("después de confirmar correctamente se sigue activando la cuenta vía /api/auth/confirm-email (sin service_role/admin en la página)", () => {
  const page = source("app/confirmar-email/page.tsx")

  assert.match(page, /fetch\("\/api\/auth\/confirm-email"/)
  assert.match(page, /Authorization: `Bearer \$\{accessToken\}`/)
  assert.match(page, /activateConfirmedAccount\(resolution\.accessToken\)/)
  assert.match(page, /setConfirmed\(true\)/)

  assert.doesNotMatch(page, /createAdminClient/)
  assert.doesNotMatch(page, /SUPABASE_SERVICE_ROLE_KEY/)
  assert.doesNotMatch(page, /admin\.updateUserById/)
})

test("estado de error muestra un mensaje claro, distinto del estado de éxito, con una salida visible (volver al login)", () => {
  const page = source("app/confirmar-email/page.tsx")

  assert.match(page, /INVALID_LINK_MESSAGE/)
  assert.match(page, /No pudimos confirmar tu cuenta/)
  // La pantalla de error no puede dejar al usuario sin ninguna acción: debe
  // ofrecer un camino de vuelta (no inventa un endpoint de reenvío nuevo --
  // el reenvío real ya vive en /login).
  assert.match(page, /<Link\s*\n?\s*href="\/login"/)
  assert.match(page, /Volver al inicio de sesión/)
})

test("el token/access_token nunca se pasa a console.log/error/warn/info en este flujo", () => {
  const page = source("app/confirmar-email/page.tsx")
  const linkModule = source("lib/auth/confirmation-link.ts")
  const controllerModule = source("lib/auth/confirmation-flow-controller.ts")

  for (const contents of [page, linkModule, controllerModule]) {
    const consoleCalls = [...contents.matchAll(/console\.(log|error|warn|info)\(([^)]*)\)/g)]
    for (const match of consoleCalls) {
      assert.doesNotMatch(match[2], /token/i)
    }
  }
})

test("lib/auth/confirmation-link.ts soporta token_hash+type=email llamando a verifyOtp (formato que manda el email hoy)", () => {
  const confirmationLink = source("lib/auth/confirmation-link.ts")

  assert.match(confirmationLink, /auth\.verifyOtp\(\{/)
  assert.match(confirmationLink, /token_hash: params\.tokenHash,/)
  assert.match(confirmationLink, /getConfirmationOtpType\(params\.type\)/)
})

test("el template de email de Confirm signup apunta a /confirmar-email con token_hash+type=email (NO type=signup), no a ConfirmationURL ni a app/auth/confirm", () => {
  const template = source("supabase/email-templates/confirm-signup.html")

  assert.doesNotMatch(template, /href="\{\{\s*\.ConfirmationURL\s*\}\}"/)
  assert.doesNotMatch(template, /\/auth\/confirm\?/)
  // Bug real auditado y corregido 2026-09-13: type=signup en verifyOtp por
  // token_hash devuelve "Token has expired or is invalid" aunque el token
  // sea válido y recién emitido -- la API real de Supabase exige type=email
  // para este caso (confirmado contra la documentación oficial). El href no
  // debe volver a usar type=signup.
  assert.doesNotMatch(template, /href="[^"]*&type=signup"/)
  assert.match(
    template,
    /href="\{\{ \.SiteURL \}\}\/confirmar-email\?token_hash=\{\{ \.TokenHash \}\}&type=email"/,
  )
})

// --- Diseño definitivo (2026-09-13): eliminado app/auth/confirm/route.ts.
// Era una segunda implementación paralela del mismo flujo de confirmación,
// pero como Route Handler GET que llamaba a verifyOtp() incondicionalmente
// -- sin ningún gate de click humano -- apenas recibía la request. Auditado
// y confirmado sin ningún emisor/consumidor real: nada en el repo lo
// enlazaba como destino, y el polling de /api/auth/confirmation-status (la
// fuente de verdad real de "¿ya se confirmó?") es independiente de qué ruta
// consumió el token. /confirmar-email (con el gate de click humano) queda
// como la única ruta de confirmación. Se eliminó junto con
// lib/auth/confirmation-events.ts (BroadcastChannel/localStorage que sólo
// esa ruta emitía) y el listener correspondiente en app/login/page.tsx.

test("app/auth/confirm ya no existe", () => {
  assert.throws(() => source("app/auth/confirm/route.ts"))
})

test("lib/auth/confirmation-events.ts ya no existe (BroadcastChannel/localStorage que sólo emitía la ruta eliminada)", () => {
  assert.throws(() => source("lib/auth/confirmation-events.ts"))
})

test("ningún archivo del repo referencia /auth/confirm como destino de link, fetch, redirect o enlace de email", () => {
  const filesToCheck = [
    "app/confirmar-email/page.tsx",
    "app/login/page.tsx",
    "components/account/auth-forms.tsx",
    "context/auth-context.tsx",
    "lib/auth/resend-confirmation.ts",
    "supabase/email-templates/confirm-signup.html",
    "supabase/email-templates/reset-password.html",
  ]

  for (const file of filesToCheck) {
    assert.doesNotMatch(
      source(file),
      /["'`]\/auth\/confirm[?"'`]/,
      `${file} no debería enlazar a /auth/confirm`,
    )
  }
})

test("app/login/page.tsx ya no tiene BroadcastChannel ni el listener de storage de confirmación (código muerto eliminado), pero conserva intacto el polling a /api/auth/confirmation-status", () => {
  const login = source("app/login/page.tsx")

  assert.doesNotMatch(login, /BroadcastChannel/)
  assert.doesNotMatch(login, /EMAIL_CONFIRMATION_CHANNEL/)
  assert.doesNotMatch(login, /EMAIL_CONFIRMATION_STORAGE_KEY/)
  assert.doesNotMatch(login, /EmailConfirmationEvent/)
  assert.doesNotMatch(login, /confirmation-events/)

  // El listener de "storage" que queda es el del cooldown de reenvío
  // (getResendCooldownStorageKey), no relacionado con la confirmación --
  // no debe existir un SEGUNDO listener de "storage" para eventos de
  // confirmación.
  const storageListenerCount = (
    login.match(/addEventListener\("storage"/g) ?? []
  ).length
  assert.equal(storageListenerCount, 1)

  // El polling real (fuente de verdad de "¿ya se confirmó?") sigue intacto.
  assert.match(login, /fetch\("\/api\/auth\/confirmation-status"/)
  assert.match(login, /window\.setTimeout\(checkConfirmation, 1000\)/)
  assert.match(login, /auth\.verifyOtp\(\{\s*\n?\s*token_hash: data\.tokenHash,\s*\n?\s*type: "magiclink",/)
})

// --- Light mode ilegible (reporte real de usuario, 2026-09-14) ---
// La tarjeta usaba bg-beyonix-surface-4 (sí adapta a Light) pero TODO el
// texto/bordes/íconos eran text-white/border-white/emerald-400/red-400 fijos,
// sin ninguna regla de override para esta página (a diferencia de
// .login-light-scope o .checkout-page) -- quedaba texto blanco sobre
// tarjeta clara. Se resolvió usando las mismas variables --account-* ya
// probadas en /login, que adaptan solas sin necesitar overrides nuevos,
// más una regla dedicada sólo para el botón sólido (que en Dark debía
// seguir siendo bg-white sin cambios).

test("/confirmar-email no tiene texto/bordes/íconos con colores fijos de dark-only (text-white, border-white, emerald-400, red-400, red-500, bg-black) sin contraparte de tema", () => {
  const page = source("app/confirmar-email/page.tsx")

  assert.doesNotMatch(page, /text-white\b/)
  assert.doesNotMatch(page, /text-white\//)
  assert.doesNotMatch(page, /border-white\//)
  assert.doesNotMatch(page, /bg-black\b/)
  assert.doesNotMatch(page, /emerald-400/)
  assert.doesNotMatch(page, /red-400/)
  assert.doesNotMatch(page, /red-500/)
  assert.doesNotMatch(page, /emerald-500/)
})

test("/confirmar-email usa las variables --account-* (mismas que /login, ya probadas en ambos temas) para fondo de página, tarjeta, texto, bordes e íconos en los 4 estados", () => {
  const page = source("app/confirmar-email/page.tsx")

  assert.match(page, /bg-\[var\(--account-background\)\]/)
  assert.match(page, /bg-\[var\(--account-surface-raised\)\]/)
  assert.match(page, /border-\[var\(--account-border\)\]/)
  assert.match(page, /text-\[var\(--account-text-primary\)\]/)
  assert.match(page, /text-\[var\(--account-text-secondary\)\]/)
  // Ícono de error (rojo) y de éxito (verde), ambos con tokens semánticos.
  assert.match(page, /border-\[var\(--account-danger-border\)\]/)
  assert.match(page, /bg-\[var\(--account-danger-bg\)\]/)
  assert.match(page, /text-\[var\(--account-danger-text\)\]/)
  assert.match(page, /border-\[var\(--account-success-border\)\]/)
  assert.match(page, /bg-\[var\(--account-success-bg\)\]/)
  assert.match(page, /text-\[var\(--account-success-text\)\]/)
  // Spinner de loading con acento de marca, no un verde/blanco fijo.
  assert.match(page, /text-\[var\(--account-accent\)\]/)
})

// --- Falso "enlace vencido" transitorio (reproducido con dos cuentas reales,
// 2026-09-14): verifyOtp podía confirmar el email exitosamente (sin error)
// sin devolver session/user en esa respuesta puntual -- lib/auth/
// confirmation-link.ts ya no trata eso como "invalid". Acá se fija que la
// página distinga correctamente los 3 desenlaces posibles de finishConfirmation.

test("confirmado sin accessToken/userId en esta pestaña: la página muestra éxito (setConfirmed), nunca el mensaje de enlace vencido", () => {
  const page = source("app/confirmar-email/page.tsx")

  const guardIndex = page.indexOf("if (!resolution.accessToken || !resolution.userId)")
  assert.ok(guardIndex >= 0, "falta el guard que distingue confirmado-sin-sesión de inválido")

  const activateCallIndex = page.indexOf(
    "await activateConfirmedAccount(resolution.accessToken)",
  )
  assert.ok(
    activateCallIndex > guardIndex,
    "el guard debe evaluarse antes de intentar activar con un accessToken potencialmente null",
  )

  const guardBlock = page.slice(guardIndex, activateCallIndex)
  assert.match(guardBlock, /setConfirmed\(true\)/)
  assert.doesNotMatch(guardBlock, /setError/)
})

test("falla de activación DESPUÉS de tener accessToken usa un mensaje distinto de INVALID_LINK_MESSAGE (no dice que el enlace venció)", () => {
  const page = source("app/confirmar-email/page.tsx")

  assert.match(page, /const ACTIVATION_ERROR_MESSAGE =/)
  assert.match(
    page,
    /Tu correo fue confirmado, pero no pudimos completar la activación de la cuenta\./,
  )

  const catchIndex = page.indexOf("} catch {", page.indexOf("await persistActivatedSession"))
  assert.ok(catchIndex >= 0)
  const catchBlock = page.slice(catchIndex, catchIndex + 320)
  assert.match(catchBlock, /setError\(ACTIVATION_ERROR_MESSAGE\)/)
  assert.doesNotMatch(catchBlock, /setError\(INVALID_LINK_MESSAGE\)/)
})

test("INVALID_LINK_MESSAGE sólo se usa para un link sin token consumible o un error real de verifyOtp/exchangeCodeForSession -- nunca dentro del guard de confirmado-sin-sesión ni del catch de activación", () => {
  const page = source("app/confirmar-email/page.tsx")

  const invalidBranchIndex = page.indexOf('if (resolution.status !== "confirmed")')
  assert.ok(invalidBranchIndex >= 0)

  // Las dos únicas apariciones legítimas: el mount effect (link sin
  // token_hash/code) y este branch (error real de verifyOtp/
  // exchangeCodeForSession). Ninguna otra rama debe agregarla.
  const usages = [...page.matchAll(/setError\(INVALID_LINK_MESSAGE\)/g)]
  assert.equal(usages.length, 2, "INVALID_LINK_MESSAGE debe usarse exactamente en esos dos lugares")
})

test("el diagnóstico temporal CONFIRM_SIGNUP_VERIFY_FAILED_TEMP_DIAGNOSTIC fue removido tras identificar y corregir la causa real", () => {
  const linkModule = source("lib/auth/confirmation-link.ts")

  assert.doesNotMatch(linkModule, /CONFIRM_SIGNUP_VERIFY_FAILED_TEMP_DIAGNOSTIC/)
  assert.doesNotMatch(linkModule, /logVerifyFailureDiagnostic/)
  assert.doesNotMatch(linkModule, /TEMPORAL/)
})

// --- Flash rojo transitorio entre el click y la confirmación (reportado en
// producción con 4 cuentas reales, 2026-09-14): mientras la respuesta de
// verifyOtp todavía está en vuelo, la pantalla debe quedarse en un estado de
// carga dedicado ("Confirmando tu cuenta..."), nunca pasar preventivamente
// por el estado de error. `confirming` se evalúa ANTES que
// `needsConfirmation` tanto en el título como en el cuerpo, así que al
// hacer click la pantalla del botón se reemplaza por esta pantalla de carga
// en vez de quedarse mostrando el botón deshabilitado.

test("al hacer click se muestra un estado de carga dedicado ('Confirmando tu cuenta...' / 'Estamos validando tu correo.'), evaluado antes que needsConfirmation", () => {
  const page = source("app/confirmar-email/page.tsx")

  const h1Index = page.indexOf("<h1 ")
  const h1CloseIndex = page.indexOf("</h1>", h1Index)
  assert.ok(h1Index >= 0 && h1CloseIndex > h1Index, "no se encontró el <h1> del título")

  const titleBlock = page.slice(h1Index, h1CloseIndex)
  const confirmingInTitleIndex = titleBlock.indexOf("confirming")
  const needsConfirmationInTitleIndex = titleBlock.indexOf("needsConfirmation")
  assert.ok(
    confirmingInTitleIndex > 0 &&
      confirmingInTitleIndex < needsConfirmationInTitleIndex,
    "el título debe chequear `confirming` antes que `needsConfirmation`",
  )
  assert.match(titleBlock, /"Confirmando tu cuenta\.\.\."/)

  const confirmingBodyIndex = page.indexOf(") : confirming ? (")
  const needsConfirmationBodyIndex = page.indexOf(") : needsConfirmation ? (")
  assert.ok(confirmingBodyIndex >= 0, "falta la rama de cuerpo para `confirming`")
  assert.ok(
    confirmingBodyIndex < needsConfirmationBodyIndex,
    "el cuerpo debe chequear `confirming` antes que `needsConfirmation`",
  )

  const confirmingBodyBlock = page.slice(confirmingBodyIndex, needsConfirmationBodyIndex)
  assert.match(confirmingBodyBlock, /Estamos validando tu correo\./)
  assert.doesNotMatch(confirmingBodyBlock, /setError|INVALID_LINK_MESSAGE/)
})

test("el estado de éxito muestra 'Cuenta verificada con éxito' (no 'Cuenta confirmada')", () => {
  const page = source("app/confirmar-email/page.tsx")

  assert.match(page, /"Cuenta verificada con éxito"/)
  assert.match(page, /Tu cuenta fue confirmada correctamente\./)
})

test("el cierre automático de la pestaña tras el éxito sigue existiendo sin cambios (timeout de 1500ms atado a `confirmed`)", () => {
  const page = source("app/confirmar-email/page.tsx")

  const effectIndex = page.indexOf("if (!confirmed) return")
  assert.ok(effectIndex >= 0)
  const effectBlock = page.slice(effectIndex, effectIndex + 300)

  assert.match(effectBlock, /window\.setTimeout\(/)
  assert.match(effectBlock, /1500/)
  assert.match(effectBlock, /window\.opener\?\.focus\(\)/)
  assert.match(effectBlock, /window\.close\(\)/)
})

test("el botón sólido de /confirmar-email (Confirmar mi cuenta / Cerrar esta pestaña / Volver al inicio de sesión) comparte una sola clase reutilizable y tiene una regla de Light dedicada que NO toca su apariencia en Dark", () => {
  const page = source("app/confirmar-email/page.tsx")

  // Los 3 (Link + 2 button) referencian la MISMA variable -- si Dark cambia
  // para uno, cambia para los 3 automáticamente.
  const sharedClassNameUses = (
    page.match(/className=\{primaryButtonClassName\}/g) ?? []
  ).length
  assert.equal(sharedClassNameUses, 3, "Link + 2 <button> deben compartir la misma className")
  assert.match(page, /beyonix-confirm-primary-button/)
  assert.match(page, /bg-white text-sm font-semibold text-black/)

  const css = source("app/globals.css")
  const scopeIndex = css.indexOf(
    'html[data-account-theme="light"][data-account-scope] .confirmar-email-scope .beyonix-confirm-primary-button',
  )
  assert.ok(scopeIndex >= 0, "falta la regla de Light para el botón de /confirmar-email")
  const scopedRule = css.slice(scopeIndex, scopeIndex + 400)
  assert.match(scopedRule, /background-color:\s*var\(--account-accent\)/)
  assert.match(scopedRule, /color:\s*#ffffff/)
})

test("/confirmar-email es la única ruta que consume el token_hash/code de Confirm signup: el template le apunta exclusivamente a ella", () => {
  const template = source("supabase/email-templates/confirm-signup.html")

  assert.match(
    template,
    /href="\{\{ \.SiteURL \}\}\/confirmar-email\?token_hash=\{\{ \.TokenHash \}\}&type=email"/,
  )
  // Única ocurrencia del link real (además de los comentarios explicativos,
  // ya cubiertos por el otro test de este archivo): un solo botón/CTA.
  const hrefs = [...template.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(hrefs, [
    "{{ .SiteURL }}/confirmar-email?token_hash={{ .TokenHash }}&type=email",
  ])
})
