import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { isValidMoneyInput, normalizeMoney, parseMoneyAmount, parseMoneyInput } from "../customer-credit.ts"

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

test("input de monto (Admin): coma y punto son decimales, máx. 2, sin letras ni signos", () => {
  // Mismo valor con coma o punto.
  for (const [value, expected] of [
    ["1000", 1000], ["1000,1", 1000.1], ["1000,10", 1000.1], ["1000.1", 1000.1], ["1000.10", 1000.1],
    ["0,5", 0.5], [",5", 0.5], ["1000,", 1000], ["1000.", 1000],
  ] as const) {
    assert.equal(isValidMoneyInput(value), true, value)
    assert.equal(parseMoneyInput(value), expected, value)
  }
  assert.equal(parseMoneyInput("1000,10"), parseMoneyInput("1000.10"))
  // Rechazados al escribir o pegar: nunca se convierten a otro monto.
  for (const value of ["abc", "$1000", "1000abc", "1000,123", "1000.123", "1.000,10", "1,000.10", "1 000", "-100", "1e3", "+5", "10,5,3"]) {
    assert.equal(isValidMoneyInput(value), false, value)
    assert.equal(parseMoneyInput(value), null, value)
  }
  assert.equal(isValidMoneyInput(""), true, "el campo puede vaciarse")
  assert.equal(parseMoneyInput(""), null)
  assert.equal(parseMoneyInput(","), null)
})

test("Admin > ajuste: el monto usa el parser canónico (antes '1000.10' se leía como 100010)", () => {
  const source = readFileSync(new URL("../../app/admin/sections/pedidos/admin-pedidos.tsx", import.meta.url), "utf8")
  assert.match(source, /const value = parseMoneyInput\(manualCreditAmount\)/)
  assert.doesNotMatch(source, /manualCreditAmount\.replace\(/)
  assert.equal(source.match(/onChange=\{\(event\) => handleManualAmountChange\(event\.target\.value\)\}/g)?.length, 2, "los dos campos del monto validan")
  assert.doesNotMatch(source, /setManualCreditAmount\(event\.target\.value\)/)
})
