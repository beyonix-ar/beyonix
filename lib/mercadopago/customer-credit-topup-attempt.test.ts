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

test("la ruta de preferencia de Mercado Pago está deshabilitada para el cliente (cambio de negocio: sin carga de saldo iniciada por el cliente)", () => {
  const route = readFileSync(
    new URL(
      "../../app/api/customer-credit/mercadopago/preference/route.ts",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(route, /status:\s*410/)
  assert.doesNotMatch(route, /preference\.create\(/)
  assert.doesNotMatch(
    route,
    /\.from\("customer_credit_topups"\)\s*\.insert\(/,
  )
})

test("una identidad inválida nunca genera una clave reutilizable", () => {
  assert.throws(
    () => getCustomerCreditTopupPreferenceIdempotencyKey("sin-identidad"),
    /identidad válida/,
  )
})
