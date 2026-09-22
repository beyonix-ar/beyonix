import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateTransferDiscount,
  calculateTransferPaymentTotal,
  calculateTransferPaymentTotalAfterCustomerCredit,
} from "./transfer.ts"

// CASO A: $6.000 de contado -> $5.400 por transferencia (10% OFF, config).
test("CASO A: transferencia aplica el % configurado (site_settings.pricing) sobre el CONTADO, nunca hardcodeado", () => {
  assert.equal(calculateTransferDiscount(6_000, 10), 600)

  const result = calculateTransferPaymentTotal(6_000, 0, 10)
  assert.equal(result.discount, 600)
  assert.equal(result.total, 5_400)
})

test("el % de descuento es configurable, no una constante fija", () => {
  assert.equal(calculateTransferDiscount(6_000, 15), 900)
  assert.equal(calculateTransferDiscount(6_000, 0), 0)
})

test("transferencia con envío: el descuento sólo se aplica sobre productos, el envío se suma entero", () => {
  const result = calculateTransferPaymentTotal(6_000, 1_000, 10)
  assert.equal(result.discount, 600)
  assert.equal(result.total, 5_400 + 1_000)
})

test("calculateTransferPaymentTotalAfterCustomerCredit: el saldo a favor se aplica antes del descuento por transferencia", () => {
  const result = calculateTransferPaymentTotalAfterCustomerCredit({
    productsTotal: 6_000,
    shipping: 0,
    customerCreditAmount: 0,
    transferDiscountPercent: 10,
  })
  assert.equal(result.discount, 600)
  assert.equal(result.total, 5_400)
})

test("CASO J: transferencia nunca recibe financiación -- su descuento no cambia según ninguna cuota, sólo según el % de transferencia configurado", () => {
  const withoutInstallmentsContext = calculateTransferDiscount(75_000, 10)
  // No existe ningún parámetro de cuotas en la firma: transferencia es
  // estructuralmente independiente de la financiación.
  assert.equal(withoutInstallmentsContext, 7_500)
})
