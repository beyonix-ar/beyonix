import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateMarketplaceNet,
  calculateMercadoPagoFees,
  calculatePendingRefundAdjustment,
  calculateTrueProfit,
  calculateWebNetSales,
  getOrderRevenueReversal,
  getProductExpenseEconomicCost,
} from "./dashboard-financials.ts"
import { getMercadoLibreCostableUnits } from "../mercadolibre/sale-costing.ts"
import {
  buildProductCostLedgers,
  getHistoricalUnitCost,
} from "./product-costs.ts"

const mpSnapshot = {
  transaction_amount: 50_000,
  transaction_details: { net_received_amount: 46_370 },
}

test("A. un pago MP normal descuenta exactamente el fee real persistido", () => {
  const fee = calculateMercadoPagoFees([mpSnapshot])
  assert.equal(fee, 3_630)
  assert.equal(
    calculateTrueProfit({
      netSales: 50_000,
      webShippingCost: 0,
      costOfGoodsSold: 0,
      operatingExpenses: 0,
      pendingReturnAdjustment: 0,
      mercadoPagoFees: fee,
    }),
    46_370,
  )
})

test("B-C. refund_pending y refunded son ramas excluyentes y mantienen el fee MP", () => {
  const pending = getOrderRevenueReversal(
    { financial_status: "refund_pending", refund_amount: 50_000, total: 50_000 },
    0,
  )
  const completed = getOrderRevenueReversal(
    { financial_status: "refunded", refunded_at: "2026-09-19T12:00:00Z", refund_amount: 50_000, total: 50_000 },
    0,
  )
  assert.deepEqual(pending, { status: "pending", amount: 50_000 })
  assert.deepEqual(completed, { status: "completed", amount: 50_000 })

  for (const reversal of [pending, completed]) {
    const netSales = calculateWebNetSales({ grossSales: 50_000, revenueReversed: reversal.amount })
    assert.equal(netSales, 0)
    assert.equal(calculateTrueProfit({
      netSales,
      webShippingCost: 0,
      costOfGoodsSold: 0,
      operatingExpenses: 0,
      pendingReturnAdjustment: 0,
      mercadoPagoFees: calculateMercadoPagoFees([mpSnapshot]),
    }), -3_630)
  }
})

test("D-E. reversión parcial y saldo más pago externo revierten el monto económico correcto", () => {
  assert.deepEqual(
    getOrderRevenueReversal(
      { financial_status: "refunded", refund_amount: 12_500, total: 50_000 },
      0,
    ),
    { status: "completed", amount: 12_500 },
  )
  assert.deepEqual(
    getOrderRevenueReversal(
      {
        financial_status: "refund_pending",
        refund_amount: 30_000,
        credit_balance_used: 20_000,
        customer_credit_restored_amount: 20_000,
        original_total: 50_000,
      },
      0,
    ),
    { status: "pending", amount: 50_000 },
  )
})

test("F-G. devolución física pendiente se ajusta una vez y se anula ante reversión de orden", () => {
  assert.equal(calculatePendingRefundAdjustment({
    unitPrice: 10_000,
    receivedQuantity: 2,
    creditedQuantity: 1,
    orderReversalStatus: "none",
  }), 10_000)
  assert.equal(calculatePendingRefundAdjustment({
    unitPrice: 10_000,
    receivedQuantity: 2,
    creditedQuantity: 0,
    orderReversalStatus: "pending",
  }), 0)
})

test("H. el refund de marketplace reduce netSales y trueProfit una sola vez", () => {
  const marketplaceNet = calculateMarketplaceNet({
    grossSales: 100_000,
    fees: 15_000,
    shipping: 5_000,
    refunds: 20_000,
  })
  assert.equal(marketplaceNet, 60_000)
  assert.equal(calculateTrueProfit({
    netSales: marketplaceNet,
    webShippingCost: 0,
    costOfGoodsSold: 25_000,
    operatingExpenses: 0,
    pendingReturnAdjustment: 0,
    mercadoPagoFees: 0,
  }), 35_000)
})

test("I-K. ML recupera costo vendible/discounted y conserva non-sellable", () => {
  const sale = { quantity: 3 }
  assert.equal(getMercadoLibreCostableUnits(sale, {
    sellableQuantity: 1,
    discountedQuantity: 0,
    nonSellableQuantity: 2,
  }), 2)
  assert.equal(getMercadoLibreCostableUnits(sale, {
    sellableQuantity: 0,
    discountedQuantity: 1,
    nonSellableQuantity: 2,
  }), 2)
  assert.equal(getMercadoLibreCostableUnits(sale, {
    sellableQuantity: 0,
    discountedQuantity: 0,
    nonSellableQuantity: 3,
  }), 3)
})

test("N. donación/sorteo registra costo económico sin crear ingreso ni duplicar OPEX", () => {
  const ledgers = buildProductCostLedgers([{
    product_id: 9,
    variant_id: 12,
    purchase_date: "2026-09-19",
    quantity: 10,
    received_quantity: 10,
    reception_status: "recibida",
    total_cost: 25_000,
  }])
  const historicalUnitCost = getHistoricalUnitCost(
    ledgers,
    9,
    12,
    "2026-09-19",
  )
  const productCost = getProductExpenseEconomicCost(3, historicalUnitCost)
  assert.equal(productCost, 7_500)
  assert.equal(calculateTrueProfit({
    netSales: 0,
    webShippingCost: 0,
    costOfGoodsSold: 0,
    operatingExpenses: productCost,
    pendingReturnAdjustment: 0,
    mercadoPagoFees: 0,
  }), -7_500)
})

test("O. el subsidio logístico usa costo real y no vuelve a restar el envío marketplace", () => {
  assert.equal(calculateTrueProfit({
    netSales: 55_000,
    webShippingCost: 8_000,
    costOfGoodsSold: 20_000,
    operatingExpenses: 2_000,
    pendingReturnAdjustment: 0,
    mercadoPagoFees: 0,
  }), 25_000)
})
