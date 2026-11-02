import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  hashForRateLimit,
  PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_DAY,
  PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_HOUR,
  PASSWORD_RESET_MAX_PER_IP_PER_DAY,
  PASSWORD_RESET_MAX_PER_IP_PER_HOUR,
} from "./password-reset-rate-limit.ts"

const MIGRATION = readFileSync(
  "supabase/migrations/20261101120000_password_reset_atomic_rate_limit.sql",
  "utf8",
)

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

test("la política sigue siendo 3/h y 6/día por identificador, 8/h y 20/día por IP", () => {
  assert.equal(PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_HOUR, 3)
  assert.equal(PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_DAY, 6)
  assert.equal(PASSWORD_RESET_MAX_PER_IP_PER_HOUR, 8)
  assert.equal(PASSWORD_RESET_MAX_PER_IP_PER_DAY, 20)
})

test("la RPC atómica usa exactamente los mismos límites que las constantes", () => {
  assert.match(MIGRATION, new RegExp(`v_identifier_hour < ${PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_HOUR}\\b`))
  assert.match(MIGRATION, new RegExp(`v_identifier_day < ${PASSWORD_RESET_MAX_PER_IDENTIFIER_PER_DAY}\\b`))
  assert.match(MIGRATION, new RegExp(`v_ip_hour < ${PASSWORD_RESET_MAX_PER_IP_PER_HOUR}\\b`))
  assert.match(MIGRATION, new RegExp(`v_ip_day < ${PASSWORD_RESET_MAX_PER_IP_PER_DAY}\\b`))
})
