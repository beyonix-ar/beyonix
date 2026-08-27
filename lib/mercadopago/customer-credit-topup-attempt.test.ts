import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { getCustomerCreditTopupPreferenceIdempotencyKey } from "./customer-credit-topup-attempt.ts"

const FIRST_ATTEMPT = "7bc6f268-a4c3-4f6c-b4bf-bf3405d3c0f1"
const SECOND_ATTEMPT = "a42f4863-c332-42d6-b639-386ef0377499"

test("el mismo intento de recarga conserva una clave idempotente estable", () => {
  assert.equal(
    getCustomerCreditTopupPreferenceIdempotencyKey(FIRST_ATTEMPT),
    getCustomerCreditTopupPreferenceIdempotencyKey(FIRST_ATTEMPT),
  )
})

test("operaciones de recarga diferentes nunca comparten la clave", () => {
  assert.notEqual(
    getCustomerCreditTopupPreferenceIdempotencyKey(FIRST_ATTEMPT),
    getCustomerCreditTopupPreferenceIdempotencyKey(SECOND_ATTEMPT),
  )
})

test("la ruta envía la clave al SDK y resuelve carreras antes de crear", () => {
  const route = readFileSync(
    new URL(
      "../../app/api/customer-credit/mercadopago/preference/route.ts",
      import.meta.url,
    ),
    "utf8",
  )
  const insertAt = route.search(
    /\.from\("customer_credit_topups"\)\s*\.insert\(/,
  )
  const conflictAt = route.indexOf('insertError.code === "23505"')
  const preferenceAt = route.indexOf("preference.create({")

  assert.ok(insertAt >= 0 && conflictAt > insertAt && preferenceAt > conflictAt)
  assert.match(
    route,
    /requestOptions:\s*{\s*idempotencyKey:\s*getCustomerCreditTopupPreferenceIdempotencyKey\(topupId\)/,
  )
})

test("una identidad inválida nunca genera una clave reutilizable", () => {
  assert.throws(
    () => getCustomerCreditTopupPreferenceIdempotencyKey("sin-identidad"),
    /identidad válida/,
  )
})
