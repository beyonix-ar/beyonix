import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { logPasswordResetAttempt } from "./password-reset-log.ts"

function captureConsoleLog(run: () => void) {
  const original = console.log
  const lines: unknown[][] = []
  console.log = (...args: unknown[]) => {
    lines.push(args)
  }
  try {
    run()
  } finally {
    console.log = original
  }
  return lines
}

test("logPasswordResetAttempt emite exactamente los campos declarados, en JSON", () => {
  const lines = captureConsoleLog(() => {
    logPasswordResetAttempt({
      identifierType: "username",
      accountResolved: true,
      resetRequested: true,
      rateLimited: false,
      providerErrorCode: null,
      correlationId: "abc123def456",
    })
  })

  assert.equal(lines.length, 1)
  const [, payload] = lines[0]
  const parsed = JSON.parse(payload as string)

  assert.deepEqual(Object.keys(parsed).sort(), [
    "accountResolved",
    "correlationId",
    "identifierType",
    "providerErrorCode",
    "rateLimited",
    "resetRequested",
  ])
  assert.equal(parsed.identifierType, "username")
  assert.equal(parsed.accountResolved, true)
})

test("un providerErrorCode se propaga tal cual al log (para diagnóstico), nunca se oculta", () => {
  const lines = captureConsoleLog(() => {
    logPasswordResetAttempt({
      identifierType: "email",
      accountResolved: true,
      resetRequested: true,
      rateLimited: false,
      providerErrorCode: "over_email_send_rate_limit",
      correlationId: "abc123def456",
    })
  })

  const parsed = JSON.parse(lines[0][1] as string)
  assert.equal(parsed.providerErrorCode, "over_email_send_rate_limit")
})

const SOURCE = readFileSync("lib/auth/password-reset-log.ts", "utf8")

test("la interfaz de log declara sólo campos diagnósticos, ningún campo que porte el dato sensible en sí", () => {
  // Se revisa la firma de la interfaz (no los comentarios, que a propósito
  // NOMBRAN "JWT"/"access token" para documentar qué NO hay que loguear).
  const interfaceBody = SOURCE.slice(
    SOURCE.indexOf("export interface PasswordResetLogEvent"),
    SOURCE.indexOf("export function logPasswordResetAttempt"),
  ).replace(/\/\*\*[\s\S]*?\*\//g, "")

  assert.doesNotMatch(interfaceBody, /accessToken|access_token/i)
  assert.doesNotMatch(interfaceBody, /service_role/i)
  assert.doesNotMatch(interfaceBody, /\bjwt\b/i)
  assert.doesNotMatch(interfaceBody, /recoveryUrl|redirectTo/i)
  // No hay un campo "email"/"username" (sólo identifierType, la CATEGORÍA
  // "email"|"username", no el valor real).
  assert.doesNotMatch(interfaceBody, /\bemail\s*:\s*string/)
  assert.doesNotMatch(interfaceBody, /\busername\s*:\s*string/)
})

test("correlationId documentado como prefijo corto no reversible, no el identificador completo", () => {
  assert.match(SOURCE, /prefijo corto/i)
  assert.match(SOURCE, /no reversible/i)
})
