import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateMercadoPagoFees,
  calculatePendingRefundAdjustment,
  getCustomerCreditRestoredOutsideCreditNotes,
  getOrderReversalWithPendingReturns,
  getOrderRevenueReversal,
  getProductExpenseEconomicCost,
  getUnattributedCreditNoteAmount,
  isDashboardPaidSale,
} from "./dashboard-financials.ts"
import {
  buildSaleFinancials,
  calculateOperatingResult,
} from "./commercial-sale-financials.ts"
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
  const sale = buildSaleFinancials({
    grossSales: 50_000,
    feeAmount: fee,
    costableUnits: 1,
    costAmount: 0,
    costSource: "historical",
  })
  assert.equal(sale.netAmount, 46_370)
  assert.equal(sale.profitAmount, 46_370)
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
    const sale = buildSaleFinancials({
      grossSales: 50_000,
      reversalAmount: reversal.amount,
      feeAmount: calculateMercadoPagoFees([mpSnapshot]),
      costableUnits: 0,
      costAmount: 0,
      costSource: "none",
    })
    assert.equal(sale.grossAmount, 0)
    assert.equal(sale.netAmount, -3_630)
    assert.equal(sale.profitAmount, -3_630)
  }
})

test("refund económico con factura y NC pendiente revierte el ingreso; la NC posterior no lo duplica", () => {
  const order = {
    financial_status: "refunded",
    refunded_at: "2026-10-20T12:00:00Z",
    invoice_status: "authorized",
    refund_amount: 10_000,
    original_total: 10_000,
  }
  assert.deepEqual(getOrderRevenueReversal(order, 0), { status: "completed", amount: 10_000 })
  // Cuando la NC se autoriza describe la misma devolución: mayor, no suma.
  assert.deepEqual(getOrderRevenueReversal(order, 10_000), { status: "completed", amount: 10_000 })
  // Reintegro parcial ya hecho y NC parcial por un monto menor: sigue el económico.
  assert.deepEqual(
    getOrderRevenueReversal({ ...order, refund_amount: 6_000 }, 4_000),
    { status: "completed", amount: 6_000 },
  )
  // Facturada sin reintegro ni NC: sigue siendo venta.
  assert.deepEqual(
    getOrderRevenueReversal({ invoice_status: "authorized", original_total: 10_000 }, 0),
    { status: "none", amount: 0 },
  )
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

test("F-G. devolución física pendiente se compara por monto con la reversión ya reconocida", () => {
  assert.equal(calculatePendingRefundAdjustment({
    unitPrice: 10_000,
    receivedQuantity: 2,
    creditedQuantity: 1,
  }), 10_000)

  const order = { original_total: 11_000, total: 11_000 }
  const base = { unattributedCreditAmount: 0, restoredCreditOutsideCreditNotes: 0, pendingReturnAmount: 10_000, orderTotal: 11_000 }
  const none = getOrderRevenueReversal(order, 0)
  assert.deepEqual(
    getOrderReversalWithPendingReturns({ ...base, reversal: none, authorizedCreditAmount: 0 }),
    { amount: 10_000, ambiguous: false },
  )
  // NC autorizada identificada como envío (1.000): no cubre el producto devuelto.
  const shippingNote = getOrderRevenueReversal(order, 1_000)
  assert.deepEqual(
    getOrderReversalWithPendingReturns({ ...base, reversal: shippingNote, authorizedCreditAmount: 1_000 }),
    { amount: 11_000, ambiguous: false },
  )
  // Reintegro económico de toda la orden: ya incluye la devolución, no se suma.
  const refunded = getOrderRevenueReversal({ ...order, financial_status: "refunded", refund_amount: 11_000 }, 0)
  assert.deepEqual(
    getOrderReversalWithPendingReturns({ ...base, reversal: refunded, authorizedCreditAmount: 0 }),
    { amount: 11_000, ambiguous: false },
  )
  // refund_pending de toda la orden: tampoco se suma.
  const pending = getOrderRevenueReversal({ ...order, financial_status: "refund_pending", refund_amount: 11_000 }, 0)
  assert.deepEqual(
    getOrderReversalWithPendingReturns({ ...base, reversal: pending, authorizedCreditAmount: 0 }),
    { amount: 11_000, ambiguous: false },
  )
})

test("NC sin ítem ni envío + devolución sin NC: se usa la cota que no duplica y se marca ambigua", () => {
  const order = { original_total: 11_000, total: 11_000 }
  const generalNote = getOrderRevenueReversal(order, 10_000)
  assert.deepEqual(
    getOrderReversalWithPendingReturns({
      reversal: generalNote, authorizedCreditAmount: 10_000, unattributedCreditAmount: 10_000,
      restoredCreditOutsideCreditNotes: 0, pendingReturnAmount: 10_000, orderTotal: 11_000,
    }),
    { amount: 10_000, ambiguous: true },
  )
  // Si un reintegro ya revirtió toda la orden, la atribución no cambia el monto.
  const refunded = getOrderRevenueReversal({ ...order, financial_status: "refunded", refund_amount: 11_000 }, 10_000)
  assert.deepEqual(
    getOrderReversalWithPendingReturns({
      reversal: refunded, authorizedCreditAmount: 10_000, unattributedCreditAmount: 10_000,
      restoredCreditOutsideCreditNotes: 0, pendingReturnAmount: 10_000, orderTotal: 11_000,
    }),
    { amount: 11_000, ambiguous: false },
  )
  // Lo no atribuido es lo que no está vinculado a ítems ni declarado como envío.
  assert.equal(getUnattributedCreditNoteAmount({ total_amount: 10_000, order_credit_note_items: [] }), 10_000)
  assert.equal(getUnattributedCreditNoteAmount({ total_amount: 1_000, original_shipping_refunded: 1_000 }), 0)
  assert.equal(getUnattributedCreditNoteAmount({
    total_amount: 11_000, original_shipping_refunded: 1_000, order_credit_note_items: [{ total_amount: 10_000 }],
  }), 0)
})

test("reintegros múltiples: con NC autorizadas manda la suma fiscal aunque refund_amount guarde sólo el último", () => {
  // Dos NC liquidadas (6.000 + 4.000); la ruta de liquidación deja en
  // refund_amount el total de la última nota (4.000).
  assert.deepEqual(
    getOrderRevenueReversal({ financial_status: "refunded", refund_amount: 4_000, original_total: 10_000 }, 10_000),
    { status: "completed", amount: 10_000 },
  )
})

test("H. el neto de marketplace descuenta reembolso, cargos y envío una sola vez", () => {
  const sale = buildSaleFinancials({
    grossSales: 100_000,
    reversalAmount: 20_000,
    feeAmount: 15_000,
    shippingCost: 5_000,
    reportedNetAmount: 60_000,
    costableUnits: 1,
    costAmount: 25_000,
    costSource: "historical",
  })
  assert.equal(sale.otherCosts, 0)
  assert.equal(sale.netAmount, 60_000)
  assert.equal(sale.profitAmount, 35_000)
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

test("ML: sólo la revisión física o return_units recuperan costo", () => {
  const sale = (parsed: Record<string, unknown>) =>
    ({ quantity: 2, gross_amount: 10_000, raw_data: { parsed } })
  // Reembolso parcial sin return_units ni revisión: costo completo.
  assert.equal(getMercadoLibreCostableUnits(sale({ status: "Entregada", cancellations_refunds: -3_000 })), 2)
  assert.equal(getMercadoLibreCostableUnits(sale({ status: "Devolución parcial", cancellations_refunds: -3_000 })), 2)
  // A. Reembolso total + tracking de devolución, sin cantidad ni revisión: costo completo.
  assert.equal(getMercadoLibreCostableUnits(sale({
    status: "Devolución en camino", cancellations_refunds: -10_000, return_tracking_number: "TRK-1",
  })), 2)
  // E. Devolución entregada al vendedor y reembolsada, sin revisión ni cantidad: costo completo.
  assert.equal(getMercadoLibreCostableUnits(sale({
    status: "Devolución finalizada. Te devolvimos el dinero", cancellations_refunds: -10_000,
    return_tracking_number: "TRK-2", return_result: "Entregada al vendedor",
  })), 2)
  assert.equal(getMercadoLibreCostableUnits(sale({ status: "Reembolsada", cancellations_refunds: -10_000 })), 2)
  // B. return_units = 1: se recupera una unidad.
  assert.equal(getMercadoLibreCostableUnits(sale({ status: "Devolución finalizada", cancellations_refunds: -10_000, return_units: 1 })), 1)
  // C-D. La revisión física manda: 1 vendible + 1 dañada recupera 1; 2 vendibles, todo.
  const refundedWithTracking = sale({ status: "Devolución finalizada", cancellations_refunds: -10_000, return_tracking_number: "TRK-3" })
  assert.equal(getMercadoLibreCostableUnits(refundedWithTracking, { sellableQuantity: 1, discountedQuantity: 0, nonSellableQuantity: 1 }), 1)
  assert.equal(getMercadoLibreCostableUnits(refundedWithTracking, { sellableQuantity: 2, discountedQuantity: 0, nonSellableQuantity: 0 }), 0)
  // Cancelada: nunca se despachó.
  assert.equal(getMercadoLibreCostableUnits(sale({ status: "Cancelada por el comprador", cancellations_refunds: -10_000 })), 0)
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
  assert.equal(calculateOperatingResult(0, productCost), -7_500)
})

test("O. el subsidio logístico web usa costo real y se resta una sola vez", () => {
  const sale = buildSaleFinancials({
    grossSales: 55_000,
    shippingCost: 8_000,
    costableUnits: 1,
    costAmount: 20_000,
    costSource: "historical",
  })
  assert.equal(sale.netAmount, 47_000)
  assert.equal(calculateOperatingResult(sale.profitAmount, 2_000), 25_000)
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
