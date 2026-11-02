import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  createPasswordResetCorrelationId,
  logPasswordResetAttempt,
  normalizeProviderErrorCode,
} from "./password-reset-log.ts"

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
      internalError: null,
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
    "internalError",
    "providerErrorCode",
    "rateLimited",
    "resetRequested",
  ])
  assert.equal(parsed.identifierType, "username")
  assert.equal(parsed.accountResolved, true)
})

test("providerErrorCode: sólo códigos conocidos de GoTrue pasan; cualquier otro valor/mensaje se colapsa", () => {
  assert.equal(
    normalizeProviderErrorCode({ code: "over_email_send_rate_limit", message: "x" }),
    "over_email_send_rate_limit",
  )
  assert.equal(
    normalizeProviderErrorCode({ code: "cliente@example.com falló", message: "SMTP 550 cliente@example.com" }),
    "provider_error_unknown",
  )
  assert.equal(normalizeProviderErrorCode({ message: "Error sin código" }), "provider_error_unknown")
  assert.equal(normalizeProviderErrorCode(new Error("boom")), "provider_error_unknown")
  assert.equal(normalizeProviderErrorCode(null), "provider_error_unknown")
})

test("correlationId es aleatorio por request y no se deriva del identificador", () => {
  const first = createPasswordResetCorrelationId()
  const second = createPasswordResetCorrelationId()

  assert.match(first, /^[0-9a-f]{16}$/)
  assert.notEqual(first, second)
  const sha = createHash("sha256").update("cliente@example.com").digest("hex")
  assert.equal(sha.startsWith(first), false)
})

const SOURCE = readFileSync("lib/auth/password-reset-log.ts", "utf8")

test("la interfaz de log declara sólo campos diagnósticos, ningún campo que porte el dato sensible en sí", () => {
  const interfaceBody = SOURCE.slice(
    SOURCE.indexOf("export interface PasswordResetLogEvent"),
    SOURCE.indexOf("export function createPasswordResetCorrelationId"),
  ).replace(/\/\*\*[\s\S]*?\*\//g, "")

  assert.doesNotMatch(interfaceBody, /accessToken|access_token/i)
  assert.doesNotMatch(interfaceBody, /service_role/i)
  assert.doesNotMatch(interfaceBody, /\bjwt\b/i)
  assert.doesNotMatch(interfaceBody, /recoveryUrl|redirectTo/i)
  assert.doesNotMatch(interfaceBody, /\bemail\s*:\s*string/)
  assert.doesNotMatch(interfaceBody, /\busername\s*:\s*string/)
  assert.doesNotMatch(interfaceBody, /\bip\s*:/)
  // providerErrorCode es una unión cerrada, no un string libre.
  assert.match(interfaceBody, /providerErrorCode: PasswordResetProviderErrorCode \| null/)
})
