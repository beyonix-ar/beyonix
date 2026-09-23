import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { normalizeMoney, parseMoneyAmount } from "../customer-credit.ts"

// Unidad: PESOS con 2 decimales (nunca centavos) en ambos helpers.

test("números JSON en pesos: 1500, 1500.5, 1500.50, 0.5 (antes 1500.5 se leía 15005)", () => {
  assert.equal(parseMoneyAmount(1500), 1500)
  assert.equal(parseMoneyAmount(1500.5), 1500.5)
  assert.equal(parseMoneyAmount(1500.5), 1500.50)
  assert.equal(parseMoneyAmount(0.5), 0.5)
  assert.equal(parseMoneyAmount(12445.34), 12445.34)
  assert.equal(parseMoneyAmount(0.005), 0.01, "se redondea a centavos, sin cambiar de unidad")

  assert.equal(normalizeMoney(1500.5), 1500.5)
  assert.equal(normalizeMoney(0.5), 0.5)
})

test("strings: decimal simple y formato es-AR", () => {
  assert.equal(parseMoneyAmount("1500"), 1500)
  assert.equal(parseMoneyAmount("1500.5"), 1500.5)
  assert.equal(parseMoneyAmount("1500.50"), 1500.5)
  assert.equal(parseMoneyAmount("0.5"), 0.5)
  assert.equal(parseMoneyAmount("1.500"), 1500, "punto de miles")
  assert.equal(parseMoneyAmount("1.500.000"), 1_500_000)
  assert.equal(parseMoneyAmount("1500,5"), 1500.5)
  assert.equal(parseMoneyAmount("1.500,50"), 1500.5)
  assert.equal(parseMoneyAmount(" $ 1.500,50 "), 1500.5)
})

test("fail-closed: inválidos, ambiguos y negativos nunca se adivinan", () => {
  for (const value of [
    null,
    undefined,
    "",
    "   ",
    "abc",
    "15OO",
    "1,500.50",
    "1.50.0",
    "1500.555",
    "1,2,3",
    "-1500",
    -1500,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    {},
    [],
    true,
  ]) {
    assert.equal(parseMoneyAmount(value), null, `debe rechazar ${String(value)}`)
    assert.equal(normalizeMoney(value), 0, `normalizeMoney(${String(value)}) = 0`)
  }
  // 0 es un monto válido para el parser pero "no usar saldo" para normalizeMoney.
  assert.equal(parseMoneyAmount(0), 0)
  assert.equal(normalizeMoney(0), 0)
})

test("no quedan parsers de montos duplicados en los checkouts ni en Admin", () => {
  const files = [
    "../../app/api/mercadopago/create-preference/route.ts",
    "../../app/api/transferencia/create-order/route.ts",
    "../../app/api/customer-credit/create-order/route.ts",
    "../../app/api/admin/clientes/saldos/route.ts",
    "../../app/api/admin/clientes/[id]/saldo/route.ts",
    "../../app/api/admin/customer-credit/route.ts",
  ]
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
    assert.doesNotMatch(source, /replace\(\/\\\.\/g, ""\)/, `${file} no debe reimplementar el parseo`)
    assert.doesNotMatch(source, /function normalize(Amount|RequestedCustomerCredit)\(/)
  }
})
