import assert from "node:assert/strict"
import test from "node:test"

import { calculateRemainingCreditableAmount } from "./credit-note-remaining.ts"

test("sin notas de crédito previas, el máximo es el total del pedido", () => {
  assert.equal(calculateRemainingCreditableAmount(50000, []), 50000)
})

test("una nota autorizada reduce el máximo disponible", () => {
  assert.equal(
    calculateRemainingCreditableAmount(50000, [
      { status: "authorized", total_amount: 20000 },
    ]),
    30000,
  )
})

test("una nota en proceso también se descuenta (está comprometida aunque no esté autorizada todavía)", () => {
  assert.equal(
    calculateRemainingCreditableAmount(50000, [
      { status: "processing", total_amount: 10000 },
    ]),
    40000,
  )
})

test("una nota rechazada o cancelada NO se descuenta (nunca se comprometió realmente)", () => {
  assert.equal(
    calculateRemainingCreditableAmount(50000, [
      { status: "rejected", total_amount: 10000 },
      { status: "cancelled", total_amount: 5000 },
    ]),
    50000,
  )
})

test("varias notas comprometidas se acumulan", () => {
  assert.equal(
    calculateRemainingCreditableAmount(50000, [
      { status: "authorized", total_amount: 20000 },
      { status: "processing", total_amount: 15000 },
    ]),
    15000,
  )
})

test("nunca devuelve un valor negativo aunque lo comprometido supere el total", () => {
  assert.equal(
    calculateRemainingCreditableAmount(10000, [
      { status: "authorized", total_amount: 15000 },
    ]),
    0,
  )
})

test("manipulación directa vía API: un importe que supera el máximo disponible debe quedar identificado como inválido por el caller", () => {
  const remaining = calculateRemainingCreditableAmount(50000, [
    { status: "authorized", total_amount: 45000 },
  ])
  const attemptedAmount = 10000 // un admin/atacante intenta acreditar más de lo disponible

  assert.equal(remaining, 5000)
  assert.ok(attemptedAmount > remaining + 0.005)
})
