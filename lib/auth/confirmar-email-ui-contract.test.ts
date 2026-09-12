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

test("estado de error muestra un mensaje claro, distinto del estado de éxito", () => {
  const page = source("app/confirmar-email/page.tsx")

  assert.match(page, /INVALID_LINK_MESSAGE/)
  assert.match(page, /No pudimos confirmar tu cuenta/)
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

test("lib/auth/confirmation-link.ts soporta token_hash+type=signup llamando a verifyOtp (formato que manda el email hoy)", () => {
  const confirmationLink = source("lib/auth/confirmation-link.ts")

  assert.match(confirmationLink, /auth\.verifyOtp\(\{/)
  assert.match(confirmationLink, /token_hash: params\.tokenHash,/)
  assert.match(confirmationLink, /getConfirmationOtpType\(params\.type\)/)
})

test("el template de email de Confirm signup apunta a /confirmar-email con token_hash+type=signup, no a ConfirmationURL ni a app/auth/confirm", () => {
  const template = source("supabase/email-templates/confirm-signup.html")

  assert.doesNotMatch(template, /href="\{\{\s*\.ConfirmationURL\s*\}\}"/)
  assert.doesNotMatch(template, /\/auth\/confirm\?/)
  assert.match(
    template,
    /href="\{\{ \.SiteURL \}\}\/confirmar-email\?token_hash=\{\{ \.TokenHash \}\}&type=signup"/,
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

test("/confirmar-email es la única ruta que consume el token_hash/code de Confirm signup: el template le apunta exclusivamente a ella", () => {
  const template = source("supabase/email-templates/confirm-signup.html")

  assert.match(
    template,
    /href="\{\{ \.SiteURL \}\}\/confirmar-email\?token_hash=\{\{ \.TokenHash \}\}&type=signup"/,
  )
  // Única ocurrencia del link real (además de los comentarios explicativos,
  // ya cubiertos por el otro test de este archivo): un solo botón/CTA.
  const hrefs = [...template.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(hrefs, [
    "{{ .SiteURL }}/confirmar-email?token_hash={{ .TokenHash }}&type=signup",
  ])
})
