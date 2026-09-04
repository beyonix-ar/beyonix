import assert from "node:assert/strict"
import test from "node:test"

import {
  hashForRateLimit,
  isPasswordResetRateLimited,
  PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_DAY,
  PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_HOUR,
  PASSWORD_RESET_MAX_PER_IP_PER_DAY,
  PASSWORD_RESET_MAX_PER_IP_PER_HOUR,
} from "./password-reset-rate-limit.ts"

function counts(overrides: Partial<Parameters<typeof isPasswordResetRateLimited>[0]> = {}) {
  return {
    identifierLastHour: 0,
    identifierLastDay: 0,
    ipLastHour: 0,
    ipLastDay: 0,
    ...overrides,
  }
}

test("hashForRateLimit es determinístico, normaliza case/espacios y nunca devuelve el valor original", () => {
  const a = hashForRateLimit("Antares")
  const b = hashForRateLimit("  antares  ")

  assert.equal(a, b)
  assert.equal(a.length, 64) // sha256 hex
  assert.doesNotMatch(a, /antares/i)
})

test("identificadores distintos producen hashes distintos", () => {
  assert.notEqual(hashForRateLimit("antares"), hashForRateLimit("orion"))
})

test("por debajo de todos los límites: no rate-limited", () => {
  assert.equal(
    isPasswordResetRateLimited(
      counts({
        identifierLastHour: PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_HOUR - 1,
        ipLastHour: PASSWORD_RESET_MAX_PER_IP_PER_HOUR - 1,
      }),
    ),
    false,
  )
})

test("al llegar al límite por identificador en la hora: rate-limited", () => {
  assert.equal(
    isPasswordResetRateLimited(
      counts({ identifierLastHour: PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_HOUR }),
    ),
    true,
  )
})

test("al llegar al límite por identificador en el día: rate-limited", () => {
  assert.equal(
    isPasswordResetRateLimited(
      counts({ identifierLastDay: PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_DAY }),
    ),
    true,
  )
})

test("al llegar al límite por IP en la hora: rate-limited (bloquea enumeración de muchos usernames desde el mismo origen)", () => {
  assert.equal(
    isPasswordResetRateLimited(counts({ ipLastHour: PASSWORD_RESET_MAX_PER_IP_PER_HOUR })),
    true,
  )
})

test("al llegar al límite por IP en el día: rate-limited", () => {
  assert.equal(
    isPasswordResetRateLimited(counts({ ipLastDay: PASSWORD_RESET_MAX_PER_IP_PER_DAY })),
    true,
  )
})

test("supera CUALQUIERA de los cuatro límites alcanza para bloquear, no hace falta superarlos todos", () => {
  assert.equal(
    isPasswordResetRateLimited(
      counts({ identifierLastHour: 0, identifierLastDay: 0, ipLastHour: 0, ipLastDay: PASSWORD_RESET_MAX_PER_IP_PER_DAY }),
    ),
    true,
  )
})
