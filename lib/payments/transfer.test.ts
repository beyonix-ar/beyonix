import assert from "node:assert/strict"
import test from "node:test"

import {
  TRANSFER_DISCOUNT_PERCENT,
  calculateTransferDiscount,
  calculateTransferPaymentTotal,
  calculateTransferPaymentTotalAfterCustomerCredit,
} from "./transfer.ts"

test("TRANSFER_DISCOUNT_PERCENT sigue siendo 10% (constante actual, no se cambia en esta corrección)", () => {
  assert.equal(TRANSFER_DISCOUNT_PERCENT, 10)
})

// CASO B (informe de precio único): $6.000 de precio público -> $5.400 por transferencia.
test("CASO B: transferencia aplica el 10% OFF sobre el PRECIO PÚBLICO ÚNICO, nunca sobre un supuesto 'precio de 1 pago' distinto", () => {
  assert.equal(calculateTransferDiscount(6_000), 600)

  const result = calculateTransferPaymentTotal(6_000, 0)
  assert.equal(result.discount, 600)
  assert.equal(result.total, 5_400)
})

test("transferencia con envío: el descuento sólo se aplica sobre productos, el envío se suma entero", () => {
  const result = calculateTransferPaymentTotal(6_000, 1_000)
  assert.equal(result.discount, 600)
  assert.equal(result.total, 5_400 + 1_000)
})

test("calculateTransferPaymentTotalAfterCustomerCredit: mismo precio público como base, el saldo a favor se aplica antes del descuento", () => {
  const result = calculateTransferPaymentTotalAfterCustomerCredit({
    productsTotal: 6_000,
    shipping: 0,
    customerCreditAmount: 0,
  })
  assert.equal(result.discount, 600)
  assert.equal(result.total, 5_400)
})
