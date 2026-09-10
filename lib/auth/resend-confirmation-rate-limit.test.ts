import assert from "node:assert/strict"
import test from "node:test"

import {
  hashForRateLimit,
  isResendConfirmationRateLimited,
  RESEND_CONFIRMATION_MAX_PER_IDENTIFIER_PER_DAY,
  RESEND_CONFIRMATION_MAX_PER_IDENTIFIER_PER_HOUR,
  RESEND_CONFIRMATION_MAX_PER_IP_PER_DAY,
  RESEND_CONFIRMATION_MAX_PER_IP_PER_HOUR,
  RESEND_CONFIRMATION_MIN_INTERVAL_SECONDS,
} from "./resend-confirmation-rate-limit.ts"

function counts(
  overrides: Partial<Parameters<typeof isResendConfirmationRateLimited>[0]> = {},
) {
  return {
    secondsSinceLastIdentifierAttempt: null,
    identifierLastHour: 0,
    identifierLastDay: 0,
    ipLastHour: 0,
    ipLastDay: 0,
    ...overrides,
  }
}

test("hashForRateLimit es determinístico, normaliza case/espacios y nunca devuelve el valor original", () => {
  const a = hashForRateLimit("Persona@Example.com")
  const b = hashForRateLimit("  persona@example.com  ")

  assert.equal(a, b)
  assert.equal(a.length, 64)
  assert.doesNotMatch(a, /persona/i)
})

test("sin intento previo (null) y por debajo de todos los límites: no rate-limited", () => {
  assert.equal(isResendConfirmationRateLimited(counts()), false)
})

test("un reenvío inmediatamente anterior (por debajo del piso de segundos): rate-limited", () => {
  assert.equal(
    isResendConfirmationRateLimited(
      counts({ secondsSinceLastIdentifierAttempt: RESEND_CONFIRMATION_MIN_INTERVAL_SECONDS - 1 }),
    ),
    true,
  )
})

test("un reenvío justo en el piso de segundos: ya no está rate-limited por el piso", () => {
  assert.equal(
    isResendConfirmationRateLimited(
      counts({ secondsSinceLastIdentifierAttempt: RESEND_CONFIRMATION_MIN_INTERVAL_SECONDS }),
    ),
    false,
  )
})

test("al llegar al límite por identificador en la hora: rate-limited", () => {
  assert.equal(
    isResendConfirmationRateLimited(
      counts({ identifierLastHour: RESEND_CONFIRMATION_MAX_PER_IDENTIFIER_PER_HOUR }),
    ),
    true,
  )
})

test("al llegar al límite por identificador en el día: rate-limited", () => {
  assert.equal(
    isResendConfirmationRateLimited(
      counts({ identifierLastDay: RESEND_CONFIRMATION_MAX_PER_IDENTIFIER_PER_DAY }),
    ),
    true,
  )
})

test("al llegar al límite por IP en la hora: rate-limited (bloquea bombardeo directo al endpoint sin pasar por el frontend)", () => {
  assert.equal(
    isResendConfirmationRateLimited(counts({ ipLastHour: RESEND_CONFIRMATION_MAX_PER_IP_PER_HOUR })),
    true,
  )
})

test("al llegar al límite por IP en el día: rate-limited", () => {
  assert.equal(
    isResendConfirmationRateLimited(counts({ ipLastDay: RESEND_CONFIRMATION_MAX_PER_IP_PER_DAY })),
    true,
  )
})

test("supera CUALQUIERA de los límites alcanza para bloquear, no hace falta superarlos todos", () => {
  assert.equal(
    isResendConfirmationRateLimited(
      counts({ ipLastDay: RESEND_CONFIRMATION_MAX_PER_IP_PER_DAY }),
    ),
    true,
  )
})
