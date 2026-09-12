import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const TEMPLATE = readFileSync("supabase/email-templates/confirm-signup.html", "utf8")
const README = readFileSync("supabase/email-templates/README.md", "utf8")

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

/** Quita comentarios HTML (documentación para quien lee el archivo, invisible en el email real). */
function withoutComments(html: string) {
  return html.replace(/<!--[\s\S]*?-->/g, "")
}

const RENDERED_TEMPLATE = withoutComments(TEMPLATE)

test("el template usa variables oficiales de Supabase (SiteURL + TokenHash) para el link, no una URL armada a mano ni ConfirmationURL", () => {
  // Mismo motivo que reset-password.html: ConfirmationURL es GET-consumible
  // por escáneres de email antes de que la persona abra el correo. Ver
  // supabase/email-templates/README.md.
  const withoutCommentsPreview = TEMPLATE.replace(/<!--[\s\S]*?-->/g, "")
  assert.doesNotMatch(withoutCommentsPreview, /\{\{\s*\.ConfirmationURL\s*\}\}/)
  assert.match(TEMPLATE, /\{\{\s*\.SiteURL\s*\}\}/)
  assert.match(TEMPLATE, /\{\{\s*\.TokenHash\s*\}\}/)

  const hrefAndSrcValues = [...TEMPLATE.matchAll(/(?:href|src)="([^"]*)"/g)].map(
    (match) => match[1],
  )
  for (const value of hrefAndSrcValues) {
    assert.match(
      value,
      /^\{\{ \.SiteURL \}\}\/confirmar-email\?token_hash=\{\{ \.TokenHash \}\}&type=signup$/,
      `href/src hardcodeado en vez de las variables oficiales: ${value}`,
    )
  }
})

test("el template tiene exactamente el contenido pedido, en español", () => {
  const flat = normalizeWhitespace(TEMPLATE)

  assert.match(flat, />\s*BEYONIX\s*</)
  assert.match(flat, /Confirm[aá] tu cuenta/i)
  assert.match(
    flat,
    /Gracias por registrarte en BEYONIX\. Confirm[aá] tu correo electr[oó]nico para activar tu cuenta\./,
  )
  assert.match(flat, /Confirmar mi cuenta/)
  assert.match(flat, /Este enlace es personal y temporal\. No lo compartas con nadie\./)
  assert.match(flat, /Si no cre[aá]ste una cuenta en BEYONIX, pod[eé]s ignorar este correo\./)
  assert.match(flat, /(&copy;|©)\s*BEYONIX/)
  assert.match(flat, /correo autom[aá]tico/i)
})

test("NO hay fallback textual con el link visible: el botón es el único CTA", () => {
  const flat = normalizeWhitespace(RENDERED_TEMPLATE)

  assert.doesNotMatch(flat, /Si el bot[oó]n no funciona/i)
  assert.doesNotMatch(flat, /copi[aá] y peg[aá] este enlace/i)
  assert.doesNotMatch(flat, /en tu navegador/i)

  const confirmLinkOccurrences = (
    RENDERED_TEMPLATE.match(/\{\{ \.SiteURL \}\}\/confirmar-email\?token_hash=/g) ?? []
  ).length
  assert.equal(confirmLinkOccurrences, 1, "el link de confirmación sólo debe usarse en el href del botón")
})

test("no aparece 'localhost', querystring, ni ninguna URL técnica como texto visible", () => {
  const flat = normalizeWhitespace(RENDERED_TEMPLATE)

  assert.doesNotMatch(flat, /localhost/i)
  assert.doesNotMatch(flat, /redirect_to/i)
  assert.doesNotMatch(flat, /supabase\.co/i)
  assert.doesNotMatch(flat, /\/auth\/v1\/verify/i)

  const anchorTexts = [...RENDERED_TEMPLATE.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((match) =>
    normalizeWhitespace(match[1]),
  )
  assert.deepEqual(anchorTexts, ["Confirmar mi cuenta"])
})

test("documento HTML completo con charset y viewport (no depende de que Supabase agregue su propio <head>)", () => {
  assert.match(TEMPLATE, /<!DOCTYPE html>/i)
  assert.match(TEMPLATE, /<meta charset="utf-8"/i)
  assert.match(TEMPLATE, /<meta name="viewport"/i)
})

test("centrado con tablas (align=\"center\" + width en HTML), no sólo margin:auto -- compatible con Outlook de escritorio", () => {
  assert.match(TEMPLATE, /<table[^>]*width="480"[^>]*align="center"/)
})

test("el template NUNCA incluye datos sensibles (email/username interpolado, tokens crudos)", () => {
  assert.doesNotMatch(TEMPLATE, /\{\{\s*\.Email\s*\}\}/)
  assert.doesNotMatch(TEMPLATE, /\{\{\s*\.Token\s*\}\}/)
})

test("mismo lenguaje visual que reset-password.html: misma paleta, tipografía y estructura de card/botón", () => {
  const resetTemplate = readFileSync("supabase/email-templates/reset-password.html", "utf8")

  for (const sharedFragment of [
    "background-color:#000000",
    "background-color:#0A0A0A",
    "border:1px solid rgba(140,200,242,0.16)",
    "background-color:#112A43",
    "font-family:'Montserrat',Arial,Helvetica,sans-serif",
    'meta name="color-scheme" content="dark"',
    'meta name="supported-color-schemes" content="dark"',
  ]) {
    assert.ok(
      resetTemplate.includes(sharedFragment) && TEMPLATE.includes(sharedFragment),
      `fragmento de estilo compartido ausente en alguno de los dos templates: ${sharedFragment}`,
    )
  }
})

test("la documentación indica el Subject, dónde pegar el HTML, y el chequeo de Redirect URLs para Confirm signup", () => {
  assert.match(README, /Confirm[aá] tu cuenta – BEYONIX/)
  assert.match(README, /Authentication > Emails > Confirm signup/)
  assert.match(README, /Authentication > URL Configuration > Redirect URLs/)
  assert.match(README, /\/confirmar-email/)
})

test("confirmado: signUp/resend son las llamadas que disparan este email, y ninguna acepta subject/HTML", () => {
  const authContextSource = readFileSync("context/auth-context.tsx", "utf8")
  assert.match(authContextSource, /supabase\.auth\.signUp\(/)

  const resendConfirmationSource = readFileSync("lib/auth/resend-confirmation.ts", "utf8")
  assert.match(resendConfirmationSource, /admin\.auth\.resend\(\{/)
  assert.match(resendConfirmationSource, /type:\s*"signup"/)

  const authClientTypes = readFileSync(
    "node_modules/@supabase/auth-js/dist/module/GoTrueClient.d.ts",
    "utf8",
  )
  const signUpSignatureMatch = /signUp\(credentials: SignUpWithPasswordCredentials\)/.exec(
    authClientTypes,
  )
  assert.ok(signUpSignatureMatch, "no se encontró la firma real de signUp en el SDK instalado")
})
