import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateMarketplaceNet,
  calculateMercadoPagoFees,
  calculatePendingRefundAdjustment,
  calculateTrueProfit,
  calculateWebNetSales,
  getCustomerCreditRestoredOutsideCreditNotes,
  getOrderRevenueReversal,
  getProductExpenseEconomicCost,
  isDashboardPaidSale,
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

test("venta cobrada = hubo pago confirmado, aunque después se cancele o reintegre", () => {
  // BX-1002 real: MP pagado, cancelado y reintegrado (payment_status=refunded).
  assert.equal(isDashboardPaidSale({ estado: "cancelado", payment_status: "refunded", financial_status: "refunded", paid_at: "2026-10-13T22:30:30Z" }), true)
  // Transferencia confirmada y luego cancelada con reintegro pendiente.
  assert.equal(isDashboardPaidSale({ estado: "cancelado", payment_status: "confirmado", financial_status: "refund_pending" }), true)
  assert.equal(isDashboardPaidSale({ estado: "pagado", payment_status: "confirmado" }), true)
  assert.equal(isDashboardPaidSale({ estado: "entregado" }), true)
  // Nunca pagado (checkout abandonado / cancelado sin pago): no es venta.
  assert.equal(isDashboardPaidSale({ estado: "pendiente", payment_status: "preference_created", financial_status: "pending_payment" }), false)
  assert.equal(isDashboardPaidSale({ estado: "cancelado", payment_status: "checkout_superseded", financial_status: "cancelled" }), false)
  // Dinero real que no fue venta (pago tardío / conflicto): se resuelve aparte.
  assert.equal(isDashboardPaidSale({ estado: "cancelado", payment_status: "approved_after_cancellation", paid_at: "2026-10-13T22:30:30Z" }), false)
  assert.equal(isDashboardPaidSale({ estado: "pendiente", payment_status: "approved_stock_conflict", paid_at: "2026-10-13T22:30:30Z" }), false)
})

test("reversión de una venta combinada: el saldo que ya devolvió la NC no se cuenta dos veces", () => {
  // $70.000 MP + $30.000 saldo, NC por $100.000 (incluye los $30.000 de saldo).
  const outside = getCustomerCreditRestoredOutsideCreditNotes(30_000, 30_000)
  assert.equal(outside, 0)
  const reversal = getOrderRevenueReversal(
    { original_total: 100_000, total: 100_000, customer_credit_restored_amount: outside, financial_status: "refunded", invoice_status: "authorized" },
    100_000,
  )
  assert.deepEqual(reversal, { status: "completed", amount: 100_000 })
  // NC parcial ($33.333,33 con $10.000 de saldo): no se suma otra vez ese saldo.
  const partial = getOrderRevenueReversal(
    { original_total: 100_000, customer_credit_restored_amount: getCustomerCreditRestoredOutsideCreditNotes(10_000, 10_000) },
    33_333.33,
  )
  assert.equal(partial.amount, 33_333.33)
  // Saldo restituido fuera de una NC (venta sin factura, legacy): sí suma.
  assert.equal(getCustomerCreditRestoredOutsideCreditNotes(20_000, 0), 20_000)
})

test("el dashboard sólo pide columnas reales de ordenes y lee el saldo de sus movimientos", async () => {
  const { readFileSync } = await import("node:fs")
  const route = readFileSync("app/api/admin/dashboard/route.ts", "utf8")
  const financialSelect = route.match(/const FINANCIAL_ORDER_SELECT = `([\s\S]*?)`/)?.[1] ?? ""
  // Columna inexistente: hacía fallar en silencio toda la lectura financiera.
  assert.doesNotMatch(financialSelect, /customer_credit_restored_amount/)
  assert.match(route, /\.in\("movement_type", \["debit", "reversal"\]\)/)
  assert.match(route, /creditRestorationsScan\.complete &&/)
  assert.match(route, /return isDashboardPaidSale\(order\)/)
})