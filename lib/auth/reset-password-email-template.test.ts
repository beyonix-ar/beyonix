import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const TEMPLATE = readFileSync("supabase/email-templates/reset-password.html", "utf8")
const README = readFileSync("supabase/email-templates/README.md", "utf8")

test("el template usa la variable oficial de Supabase para el link, no una URL armada a mano", () => {
  assert.match(TEMPLATE, /\{\{\s*\.ConfirmationURL\s*\}\}/)

  // Se ignoran namespaces XML estándar del <html> (xmlns="http://www.w3.org/1999/xhtml"),
  // que no son links de la app -- sólo importa que ningún href/src apunte a
  // un dominio hardcodeado.
  const hrefAndSrcValues = [...TEMPLATE.matchAll(/(?:href|src)="([^"]*)"/g)].map(
    (match) => match[1],
  )
  for (const value of hrefAndSrcValues) {
    assert.match(
      value,
      /\{\{\s*\.ConfirmationURL\s*\}\}/,
      `href/src hardcodeado en vez de la variable oficial: ${value}`,
    )
  }
})

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

/** Quita comentarios HTML (documentación para quien lee el archivo, invisible en el email real). */
function withoutComments(html: string) {
  return html.replace(/<!--[\s\S]*?-->/g, "")
}

const RENDERED_TEMPLATE = withoutComments(TEMPLATE)

test("el template tiene exactamente el contenido pedido, en español", () => {
  const flat = normalizeWhitespace(TEMPLATE)

  assert.match(flat, />\s*BEYONIX\s*</)
  assert.match(flat, /Restablecer contrase[ñn]a/i)
  assert.match(flat, /Recibimos una solicitud para cambiar la contrase[ñn]a de tu cuenta\./)
  assert.match(flat, /Crear nueva contrase[ñn]a/)
  assert.match(flat, /Este enlace es personal y temporal\. No lo compartas con nadie\./)
  assert.match(
    flat,
    /Si no solicitaste este cambio, pod[eé]s ignorar este correo\. Tu contrase[ñn]a actual seguir[aá] funcionando\./,
  )
  assert.match(flat, /(&copy;|©)\s*BEYONIX/)
  assert.match(flat, /correo autom[aá]tico/i)
})

test("NO hay fallback textual con el link visible: el botón es el único CTA (pedido explícito, evita exponer la URL técnica)", () => {
  const flat = normalizeWhitespace(RENDERED_TEMPLATE)

  assert.doesNotMatch(flat, /Si el bot[oó]n no funciona/i)
  assert.doesNotMatch(flat, /copi[aá] y peg[aá] este enlace/i)
  assert.doesNotMatch(flat, /en tu navegador/i)

  // La variable oficial aparece EXACTAMENTE una vez en el HTML que
  // realmente se renderiza (el href del botón) -- ninguna segunda vez como
  // texto visible. Los comentarios de documentación que la MENCIONEN (para
  // explicar la decisión) no cuentan: son invisibles en el email real.
  const confirmationUrlOccurrences = (RENDERED_TEMPLATE.match(/\{\{\s*\.ConfirmationURL\s*\}\}/g) ?? []).length
  assert.equal(confirmationUrlOccurrences, 1, "ConfirmationURL sólo debe usarse en el href del botón")
})

test("no aparece 'localhost', querystring, ni ninguna URL técnica como texto visible", () => {
  const flat = normalizeWhitespace(RENDERED_TEMPLATE)

  assert.doesNotMatch(flat, /localhost/i)
  assert.doesNotMatch(flat, /redirect_to/i)
  assert.doesNotMatch(flat, /supabase\.co/i)
  assert.doesNotMatch(flat, /\/auth\/v1\/verify/i)
  // Ningún <a> visible además del botón de "Crear nueva contraseña".
  const anchorTexts = [...RENDERED_TEMPLATE.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((match) =>
    normalizeWhitespace(match[1]),
  )
  assert.deepEqual(anchorTexts, ["Crear nueva contraseña"])
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

test("la documentación es honesta sobre que el email de confirmación vive en el Dashboard, no en el repo", () => {
  const flatReadme = normalizeWhitespace(README)

  assert.match(flatReadme, /no existe ninguno/i)
  assert.match(flatReadme, /vive únicamente en el Dashboard/i)
})

test("la documentación indica el Subject, dónde pegar el HTML, y el chequeo de Redirect URLs", () => {
  assert.match(README, /Restablecer contraseña – BEYONIX/)
  assert.match(README, /Authentication > Emails > Reset Password/)
  assert.match(README, /Authentication > URL Configuration > Redirect URLs/)
  assert.match(README, /\/reset-password/)
})

test("la documentación confirma, verificado contra el código real, que el Subject es exclusivo de Supabase Dashboard", () => {
  const flatReadme = normalizeWhitespace(README)

  assert.match(flatReadme, /No existe un parámetro de subject/i)
  assert.match(
    flatReadme,
    /mientras no entres a Authentication > Emails > Reset Password[\s\S]*?el correo real va a seguir diciendo/i,
  )
})

test("confirmado: resetPasswordForEmail es la ÚNICA llamada que dispara este email, y su firma real no acepta subject/HTML", () => {
  const forgotPasswordSource = readFileSync("lib/auth/forgot-password.ts", "utf8")
  const resetCalls = [...forgotPasswordSource.matchAll(/resetPasswordForEmail\(/g)]
  assert.equal(resetCalls.length, 1, "debe haber una única llamada a resetPasswordForEmail en todo el flujo")

  const authClientTypes = readFileSync(
    "node_modules/@supabase/auth-js/dist/module/GoTrueClient.d.ts",
    "utf8",
  )
  const signatureMatch = /resetPasswordForEmail\(email: string, options\?: \{([^}]*)\}/.exec(
    authClientTypes,
  )
  assert.ok(signatureMatch, "no se encontró la firma real de resetPasswordForEmail en el SDK instalado")
  assert.doesNotMatch(signatureMatch![1], /subject/i)
  assert.doesNotMatch(signatureMatch![1], /html/i)
  assert.doesNotMatch(signatureMatch![1], /template/i)
})
