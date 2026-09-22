import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateCustomerCreditApplication,
  roundMoney,
} from "../customer-credit.ts"
import { calculateStoreBenefitDiscount } from "../customer-store-benefits.ts"
import type { InstallmentCount, InstallmentsFinancingConfig } from "../products/installments.ts"
import {
  getCartFinancedTotal,
  getInstallmentAmount,
  getInstallmentCountsDivisor,
  roundUpCheckoutTotalForInstallments,
  type CartFinanceableLine,
} from "./financed-pricing.ts"

const REAL_CONFIG: InstallmentsFinancingConfig = {
  baseProcessingPercent: 6.42,
  ivaPercent: 21,
  surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 },
}

const ALL_COUNTS: InstallmentCount[] = [2, 3, 6]

function cents(amount: number): number {
  return Math.round(amount * 100)
}

/**
 * Réplica del cálculo de create-preference con cuotas elegidas: financiado
 * por línea, beneficio sobre el financiado crudo, envío a costo real (sin
 * gross-up), saldo a favor y, al final, UN único ajuste de redondeo.
 */
function financedCheckout({
  lines,
  shipping = 0,
  storeBenefitPercent = null,
  creditBalance = 0,
  offeredCounts = ALL_COUNTS,
}: {
  lines: CartFinanceableLine[]
  shipping?: number
  storeBenefitPercent?: number | null
  creditBalance?: number
  offeredCounts?: InstallmentCount[]
}) {
  const rawFinancedProducts = getCartFinancedTotal(lines, REAL_CONFIG)
  const storeBenefitDiscount = calculateStoreBenefitDiscount(
    rawFinancedProducts,
    storeBenefitPercent,
  )
  const financedTotal = roundMoney(
    Math.max(rawFinancedProducts - storeBenefitDiscount, 0) + shipping,
  )
  const credit = calculateCustomerCreditApplication({
    availableBalance: creditBalance,
    eligibleTotal: financedTotal,
    requestedAmount: creditBalance,
  })
  const rounded = roundUpCheckoutTotalForInstallments({
    total: financedTotal,
    customerCreditApplied: credit.appliedAmount,
    offeredCounts,
  })

  return {
    financedTotal,
    requestedCredit: credit.appliedAmount,
    ...rounded,
  }
}

function assertExactInstallments(finalTotal: number, counts: InstallmentCount[]) {
  const finalCents = cents(finalTotal)
  const products = counts.map((count) => {
    const amount = getInstallmentAmount(finalTotal, count)!
    // La cuota es un importe exacto al centavo, sin fracciones de centavo.
    assert.ok(Math.abs(amount * 100 - cents(amount)) < 1e-6, `cuota ${count} no es exacta: ${amount}`)
    return cents(amount) * count
  })

  for (const product of products) {
    assert.equal(product, finalCents)
  }
}

function assertRoundingInvariants(result: ReturnType<typeof financedCheckout>, divisor = 6) {
  const adjustmentCents = cents(result.roundingAdjustment)

  assert.ok(adjustmentCents >= 0, "el ajuste nunca es negativo")
  assert.ok(adjustmentCents < divisor, `ajuste ${adjustmentCents} >= ${divisor} centavos`)
  // `total = cobrado + saldo` se conserva (lo recalculan las RPC de saldo).
  assert.equal(cents(result.total), cents(result.externalAmountDue) + cents(result.customerCreditApplied))
  assert.equal(cents(result.total), cents(result.financedTotal) + adjustmentCents)
  // El saldo sólo puede bajar (lo no aplicado queda en la billetera), nunca más de divisor-1 centavos.
  const creditTrimCents = cents(result.requestedCredit) - cents(result.customerCreditApplied)
  assert.ok(creditTrimCents >= 0 && creditTrimCents < divisor, `saldo recortado ${creditTrimCents}`)
  // total, saldo y cobro externo: TODOS divisibles (reversión de saldo incluida).
  assert.equal(cents(result.total) % divisor, 0)
  assert.equal(cents(result.customerCreditApplied) % divisor, 0)
  assert.equal(cents(result.externalAmountDue) % divisor, 0)
}

const LINES: CartFinanceableLine[] = [
  { cashPrice: 51_673, maxEligibleCount: 6, quantity: 1 },
  { cashPrice: 12_345, maxEligibleCount: 6, quantity: 2 },
]

test("CHECKOUT A: sólo productos -- 2, 3 y 6 cuotas cierran exacto el total final", () => {
  const result = financedCheckout({ lines: LINES })

  assertRoundingInvariants(result)
  // Los financiados por producto ya son múltiplos de 6: sin envío ni saldo no hace falta ajuste.
  assert.equal(result.roundingAdjustment, 0)
  assertExactInstallments(result.externalAmountDue, ALL_COUNTS)
})

test("CHECKOUT B: productos + envío con centavos no divisible -- el envío no se toca, sólo se redondea el total final", () => {
  const shipping = 8_437.37
  const result = financedCheckout({ lines: LINES, shipping })

  assertRoundingInvariants(result)
  assert.ok(result.roundingAdjustment > 0)
  // El envío entra a costo real: total antes del ajuste = financiado productos + envío.
  assert.equal(
    cents(result.financedTotal),
    cents(getCartFinancedTotal(LINES, REAL_CONFIG)) + cents(shipping),
  )
  assertExactInstallments(result.externalAmountDue, ALL_COUNTS)
})

test("CHECKOUT C: productos + beneficio de tienda", () => {
  const result = financedCheckout({ lines: LINES, storeBenefitPercent: 7 })

  assertRoundingInvariants(result)
  assertExactInstallments(result.externalAmountDue, ALL_COUNTS)
})

test("CHECKOUT D: productos + saldo a favor -- el saldo no se financia; se aplica al múltiplo de las cuotas", () => {
  const creditBalance = 12_345.67
  const result = financedCheckout({ lines: LINES, creditBalance })

  assertRoundingInvariants(result)
  assert.equal(result.requestedCredit, creditBalance)
  // 12.345,67 -> 12.345,66 (múltiplo de 6 centavos); el centavo queda en la billetera.
  assert.equal(result.customerCreditApplied, 12_345.66)
  assertExactInstallments(result.externalAmountDue, ALL_COUNTS)
})

test("CHECKOUT E: productos + envío + beneficio + saldo", () => {
  const result = financedCheckout({
    lines: LINES,
    shipping: 9_999.99,
    storeBenefitPercent: 13,
    creditBalance: 4_321.09,
  })

  assertRoundingInvariants(result)
  assertExactInstallments(result.externalAmountDue, ALL_COUNTS)
})

test("el total final es el MISMO elija el cliente 2, 3 o 6 cuotas -- el ajuste depende de las cuotas ofrecidas, no de la elegida", () => {
  const result = financedCheckout({ lines: LINES, shipping: 8_437.37, creditBalance: 1_000.01 })
  const amount2 = getInstallmentAmount(result.externalAmountDue, 2)!
  const amount3 = getInstallmentAmount(result.externalAmountDue, 3)!
  const amount6 = getInstallmentAmount(result.externalAmountDue, 6)!

  assert.equal(cents(amount2) * 2, cents(result.externalAmountDue))
  assert.equal(cents(amount3) * 3, cents(result.externalAmountDue))
  assert.equal(cents(amount6) * 6, cents(result.externalAmountDue))
  assert.equal(cents(amount2) * 2, cents(amount3) * 3)
  assert.equal(cents(amount3) * 3, cents(amount6) * 6)
})

test("el divisor es el mínimo común múltiplo de las cuotas OFRECIDAS al carrito", () => {
  assert.equal(getInstallmentCountsDivisor([2, 3, 6]), 6)
  assert.equal(getInstallmentCountsDivisor([2, 3]), 6)
  assert.equal(getInstallmentCountsDivisor([3]), 3)
  assert.equal(getInstallmentCountsDivisor([2]), 2)
  assert.equal(getInstallmentCountsDivisor([]), 1)

  const onlyTwo = financedCheckout({
    lines: [{ cashPrice: 10_000, maxEligibleCount: 2, quantity: 1 }],
    shipping: 1_234.57,
    offeredCounts: [2],
  })
  assertRoundingInvariants(onlyTwo, 2)
  assertExactInstallments(onlyTwo.externalAmountDue, [2])
})

test("barrido: con 2/3/6 ofrecidas el ajuste nunca supera 5 centavos y siempre divide exacto", () => {
  for (let step = 0; step < 500; step++) {
    const shipping = roundMoney((step * 37.13) % 25_000)
    const creditBalance = step % 3 === 0 ? roundMoney((step * 91.07) % 30_000) : 0
    const result = financedCheckout({
      lines: [
        { cashPrice: 10_000 + step * 173, maxEligibleCount: 6, quantity: 1 + (step % 3) },
        { cashPrice: 4_999 + step * 11, maxEligibleCount: 3, quantity: 1 },
      ],
      shipping,
      storeBenefitPercent: step % 4 === 0 ? 5 + (step % 20) : null,
      creditBalance,
    })

    if (result.externalAmountDue <= 0) continue
    assertRoundingInvariants(result)
    assert.ok(cents(result.roundingAdjustment) <= 5)
    assertExactInstallments(result.externalAmountDue, ALL_COUNTS)
  }
})

test("monto ya divisible no se modifica; saldo que cubre todo no genera ajuste", () => {
  assert.deepEqual(
    roundUpCheckoutTotalForInstallments({ total: 63_018.06, customerCreditApplied: 0, offeredCounts: ALL_COUNTS }),
    { total: 63_018.06, externalAmountDue: 63_018.06, customerCreditApplied: 0, roundingAdjustment: 0 },
  )
  assert.deepEqual(
    roundUpCheckoutTotalForInstallments({ total: 63_018.01, customerCreditApplied: 0, offeredCounts: ALL_COUNTS }),
    { total: 63_018.06, externalAmountDue: 63_018.06, customerCreditApplied: 0, roundingAdjustment: 0.05 },
  )
  assert.deepEqual(
    roundUpCheckoutTotalForInstallments({ total: 1_000, customerCreditApplied: 1_000, offeredCounts: ALL_COUNTS }),
    { total: 1_000, externalAmountDue: 0, customerCreditApplied: 1_000, roundingAdjustment: 0 },
  )
  // Saldo parcial: el total se redondea sin depender del saldo y el saldo baja al múltiplo.
  assert.deepEqual(
    roundUpCheckoutTotalForInstallments({ total: 63_018.01, customerCreditApplied: 1_000.05, offeredCounts: ALL_COUNTS }),
    { total: 63_018.06, externalAmountDue: 62_018.04, customerCreditApplied: 1_000.02, roundingAdjustment: 0.05 },
  )
})
