import assert from "node:assert/strict"
import test from "node:test"

import type { SupabasePedido, SupabasePedidoItem } from "../supabase/types.ts"
import { calculateOperatingResult, summarizeSaleFinancials } from "./commercial-sale-financials.ts"
import {
  buildDashboardLedger,
  type DashboardLedgerInput,
} from "./dashboard-commercial-ledger.ts"
import { filterCommercialSales, buildSalesEvolution } from "./dashboard-sales-analytics.ts"
import { argentinaDateKey } from "./dashboard-timezone.ts"
import {
  getMercadoLibreCostableUnits,
  toMercadoLibrePhysicalReview,
} from "../mercadolibre/sale-costing.ts"

// Agregado real del Dashboard (el mismo que usa app/api/admin/dashboard):
// cada caso arma las filas tal como llegan de Supabase.

function order(fields: Partial<SupabasePedido>): SupabasePedido {
  return {
    estado: "pagado",
    payment_status: "approved",
    paid_at: "2026-10-01T15:00:00.000Z",
    created_at: "2026-10-01T14:00:00.000Z",
    ...fields,
  } as SupabasePedido
}

function item(fields: Partial<SupabasePedidoItem>): SupabasePedidoItem {
  return {
    variante_id: null,
    cantidad: 1,
    return_restocked_quantity: 0,
    return_written_off_quantity: 0,
    productos: { id: 1, nombre: "Auriculares", categorias: { nombre: "Audio" } },
    ...fields,
  } as SupabasePedidoItem
}

function mlRow(fields: Record<string, unknown>) {
  return {
    sale_date: "2026-10-02T13:00:00.000Z",
    quantity: 1,
    fee_amount: 0,
    shipping_amount: 0,
    raw_data: { parsed: { status: "Entregada" } },
    ...fields,
  }
}

function externalRow(fields: Record<string, unknown>) {
  return {
    sale_date: "2026-10-03",
    product_id: null,
    variant_id: null,
    quantity: 1,
    unit_cost: 0,
    fee_amount: 0,
    shipping_amount: 0,
    other_expense_amount: 0,
    status: "completed",
    reversal_kind: null,
    return_condition: null,
    stock_effect: "consume",
    declared_profit: null,
    ...fields,
  }
}

function ledger(input: Partial<DashboardLedgerInput>) {
  return buildDashboardLedger({
    orders: [],
    items: [],
    authorizedCreditNotes: [],
    creditMovements: [],
    marketplaceRows: [],
    marketplaceReturnReviews: [],
    externalRows: [],
    productCosts: [],
    expenses: [],
    ...input,
  })
}

const mpFee300 = { transaction_amount: 10_000, transaction_details: { net_received_amount: 9_700 } }

const webNormal = {
  orders: [order({ id: 1, total: 10_000, original_total: 10_000, mercadopago_payment_snapshot: mpFee300, shipping_provider_quote_amount: 800 })],
  items: [item({ id: 11, orden_id: 1, producto_id: 1, precio: 10_000, costo_unitario_historico: 4_000 })],
}
const mlNormal = mlRow({ id: "ml-1", gross_amount: 10_000, fee_amount: 1_500, shipping_amount: 500, net_amount: 8_200, costo_unitario_historico: 4_000 })
const externalHistorical = externalRow({
  id: "ext-1",
  gross_amount: 10_000,
  fee_amount: 500,
  shipping_amount: 300,
  other_expense_amount: 200,
  stock_effect: "none",
  declared_profit: 4_000,
})

test("A. web: total 10.000, COGS 4.000, envío 800, comisión MP 300 → resultado 4.900", () => {
  const { sales, totals } = ledger(webNormal)
  assert.equal(sales.length, 1)
  const [line] = sales
  assert.equal(line.grossAmount, 10_000)
  assert.equal(line.feeAmount, 300)
  assert.equal(line.shippingCost, 800)
  assert.equal(line.netAmount, 8_900)
  assert.equal(line.costAmount, 4_000)
  assert.equal(line.costSource, "snapshot")
  assert.equal(line.profitAmount, 4_900)
  assert.equal(line.marginPercent, 49)
  assert.equal(totals.contributionResult, 4_900)
})

test("B. ML: el neto es net_amount (Total liquidado) y el desglose concilia", () => {
  const { sales } = ledger({ marketplaceRows: [mlNormal] })
  const [line] = sales
  assert.equal(line.grossAmount, 10_000)
  assert.equal(line.feeAmount, 1_500)
  assert.equal(line.shippingCost, 500)
  // Ingreso por envío de $200 incluido en el Total: queda como ajuste a favor.
  assert.equal(line.otherCosts, -200)
  assert.equal(line.netAmount, 8_200)
  assert.equal(line.grossAmount - line.feeAmount - line.shippingCost - line.otherCosts, line.netAmount)
  assert.equal(line.profitAmount, 4_200)
})

test("C/J. externa histórica: neto 9.000, ganancia declarada 4.000 y costo marcado como inferido", () => {
  const { sales, totals } = ledger({ externalRows: [externalHistorical] })
  const [line] = sales
  assert.equal(line.netAmount, 9_000)
  assert.equal(line.profitAmount, 4_000)
  assert.equal(line.costAmount, 5_000)
  assert.equal(line.costSource, "inferred")
  assert.equal(totals.inferredCostUnits, 1)
  assert.equal(totals.costCoveragePercent, 100)
  assert.equal(totals.inferredCostPercent, 100)

  const mixed = summarizeSaleFinancials([...ledger(webNormal).sales, ...sales])
  assert.equal(mixed.costCoveragePercent, 100)
  assert.equal(mixed.inferredCostPercent, 50)
  assert.equal(mixed.confirmedCostUnits, 1)
})

test("D. pérdida: ingreso 10.000 con costo 15.000 → resultado −5.000", () => {
  const { sales, totals } = ledger({
    externalRows: [externalRow({ id: "ext-loss", gross_amount: 10_000, unit_cost: 15_000 })],
  })
  assert.equal(sales[0].costSource, "manual")
  assert.equal(sales[0].profitAmount, -5_000)
  assert.equal(totals.contributionResult, -5_000)
})

test("E. web facturada y reintegrada con NC pendiente: el ingreso ya es 0 y la NC posterior no descuenta otra vez", () => {
  const refunded = order({
    id: 2,
    estado: "cancelado",
    total: 10_000,
    original_total: 10_000,
    invoice_status: "authorized",
    financial_status: "refunded",
    refunded_at: "2026-10-05T12:00:00.000Z",
    refund_amount: 10_000,
    mercadopago_payment_snapshot: mpFee300,
  })
  // Cancelada antes del despacho: la unidad volvió al stock.
  const items = [item({ id: 21, orden_id: 2, producto_id: 1, precio: 10_000, costo_unitario_historico: 4_000, return_restocked_quantity: 1 })]

  const pendingNote = ledger({ orders: [refunded], items })
  assert.equal(pendingNote.totals.grossAmount, 0)
  assert.equal(pendingNote.totals.netSales, -300)
  assert.equal(pendingNote.totals.contributionResult, -300)
  assert.equal(pendingNote.web.completedRefunds, 10_000)
  // La unidad volvió: la reversión queda en su línea y el reintegro no la suma otra vez.
  assert.equal(pendingNote.totals.reversals, 10_000)
  assert.equal(pendingNote.web.pendingReturnAdjustment, 0)
  assert.equal(pendingNote.sales.find((sale) => sale.kind === "sale")?.reversalAmount, 10_000)
  assert.equal(pendingNote.sales.some((sale) => sale.kind === "adjustment"), false)

  // Reintegro sin devolución física (la mercadería no volvió): ajuste de pedido.
  const notReturned = ledger({ orders: [refunded], items: [{ ...items[0], return_restocked_quantity: 0 }] })
  const adjustment = notReturned.sales.find((sale) => sale.kind === "adjustment")
  assert.equal(adjustment?.reversalAmount, 10_000)
  assert.equal(adjustment?.orderId, "2")
  assert.equal(notReturned.totals.reversals, 10_000)

  const authorizedNote = ledger({
    orders: [refunded],
    items,
    authorizedCreditNotes: [{
      id: "nc-1",
      order_id: 2,
      total_amount: 10_000,
      manual_amount: 0,
      authorized_at: "2026-10-06T12:00:00.000Z",
      order_credit_note_items: [{ order_item_id: 21, quantity: 1, total_amount: 10_000 }],
    }],
  })
  assert.equal(authorizedNote.totals.grossAmount, 0)
  assert.equal(authorizedNote.totals.reversals, 10_000)
  assert.equal(authorizedNote.totals.contributionResult, -300)
  assert.equal(authorizedNote.sales.some((sale) => sale.kind === "adjustment"), false)
})

test("F. externa devuelta dañada: ingreso revertido, costo perdido y gastos no recuperados", () => {
  const damaged = externalRow({
    id: "ext-damaged",
    gross_amount: 10_000,
    unit_cost: 4_000,
    status: "reversed",
    reversal_kind: "return",
    return_condition: "damaged",
  })
  const { sales, totals, external } = ledger({ externalRows: [damaged] })
  assert.equal(sales[0].grossAmount, 0)
  assert.equal(sales[0].quantity, 0)
  assert.equal(sales[0].costAmount, 4_000)
  assert.equal(sales[0].profitAmount, -4_000)
  assert.equal(totals.contributionResult, -4_000)
  assert.equal(external.damagedReturnReversals, 10_000)

  const withCosts = ledger({ externalRows: [{ ...damaged, fee_amount: 500, shipping_amount: 300 }] })
  assert.equal(withCosts.totals.contributionResult, -4_800)

  // Anulación, error de carga, tanda deshecha y devolución vendible: no suman.
  const excluded = ledger({
    externalRows: [
      { ...damaged, id: "a", return_condition: "sellable" },
      { ...damaged, id: "b", reversal_kind: "entry_error", return_condition: null },
      { ...damaged, id: "c", reversal_kind: "batch_undo", return_condition: null },
      { ...damaged, id: "d", reversal_kind: null, return_condition: null },
    ],
  })
  assert.equal(excluded.sales.length, 0)
  assert.equal(excluded.totals.contributionResult, 0)
})

test("G. una fecha YYYY-MM-DD es un día argentino, nunca el anterior", () => {
  assert.equal(argentinaDateKey("2026-05-01"), "2026-05-01")
  assert.equal(argentinaDateKey("2026-01-01"), "2026-01-01")
  const { sales } = ledger({ externalRows: [externalRow({ id: "may", sale_date: "2026-05-01", gross_amount: 1_000, unit_cost: 100 })] })
  const range = { from: "2026-05-01", to: "2026-05-01" }
  assert.equal(filterCommercialSales(sales, { range, channel: "todos", product: "", category: "" }).length, 1)
  assert.equal(filterCommercialSales(sales, { range: { from: "2026-04-30", to: "2026-04-30" }, channel: "todos", product: "", category: "" }).length, 0)
  assert.equal(buildSalesEvolution(sales, range, "day")[0].total, 1_000)
})

test("H. una NC sin ítem reduce igual el resumen y la facturación comercial", () => {
  const { sales, totals, web } = ledger({
    orders: [order({ id: 3, total: 10_000, original_total: 10_000, invoice_status: "authorized" })],
    items: [
      item({ id: 31, orden_id: 3, producto_id: 1, precio: 6_000, costo_unitario_historico: 2_000 }),
      item({ id: 32, orden_id: 3, producto_id: 2, precio: 4_000, costo_unitario_historico: 1_000 }),
    ],
    authorizedCreditNotes: [{
      id: "nc-envio",
      order_id: 3,
      total_amount: 1_000,
      manual_amount: 1_000,
      authorized_at: "2026-10-04T12:00:00.000Z",
      order_credit_note_items: [],
    }],
  })
  const commercialBilling = sales.reduce((total, sale) => total + (sale.grossAmount ?? Number.NaN), 0)
  assert.equal(commercialBilling, 9_000)
  assert.equal(totals.grossAmount, 9_000)
  assert.equal(totals.netSales, 9_000)
  assert.equal(web.completedRefunds, 1_000)
  const adjustment = sales.find((sale) => sale.kind === "adjustment")
  assert.equal(adjustment?.productName, "Ajuste pedido #3")
  assert.equal(adjustment?.grossAmount, -1_000)
  assert.equal(totals.contributionResult, 6_000)
})

test("I. sin costo no se inventa resultado", () => {
  const { sales, totals } = ledger({
    orders: [order({ id: 4, total: 10_000, original_total: 10_000 })],
    items: [item({ id: 41, orden_id: 4, producto_id: 99, precio: 10_000, costo_unitario_historico: null })],
  })
  assert.equal(sales[0].costAmount, null)
  assert.equal(sales[0].costSource, "missing")
  assert.equal(sales[0].profitAmount, null)
  assert.equal(totals.contributionResult, null)
  assert.equal(totals.linesWithoutCost, 1)
  assert.equal(totals.costCoveragePercent, 0)
})

test("ML: cancelación total, reembolso parcial y costo recuperado según la revisión física", () => {
  const { sales } = ledger({
    marketplaceRows: [
      mlRow({ id: "cancel", gross_amount: 5_000, net_amount: 0, costo_unitario_historico: 2_000, raw_data: { parsed: { status: "Cancelada por el comprador", cancellations_refunds: -5_000 } } }),
      mlRow({ id: "partial", quantity: 2, gross_amount: 10_000, fee_amount: 1_000, net_amount: 6_000, costo_unitario_historico: 2_000, raw_data: { parsed: { status: "Entregada", cancellations_refunds: -3_000, return_units: 1 } } }),
      mlRow({ id: "recovered", gross_amount: 8_000, net_amount: 0, costo_unitario_historico: 2_000, raw_data: { parsed: { status: "Devolución", cancellations_refunds: -8_000 } } }),
      mlRow({ id: "lost", gross_amount: 8_000, net_amount: 0, costo_unitario_historico: 2_000, raw_data: { parsed: { status: "Devolución", cancellations_refunds: -8_000 } } }),
    ],
    marketplaceReturnReviews: [
      { mercadolibre_sale_id: "recovered", sellable_quantity: 1, discounted_quantity: 0, non_sellable_quantity: 0 },
      { mercadolibre_sale_id: "lost", sellable_quantity: 0, discounted_quantity: 0, non_sellable_quantity: 1 },
    ],
  })
  const byId = new Map(sales.map((sale) => [sale.id, sale]))
  const cancelled = byId.get("ml-cancel")!
  assert.equal(cancelled.grossAmount, 0)
  assert.equal(cancelled.netAmount, 0)
  assert.equal(cancelled.costAmount, 0)
  assert.equal(cancelled.profitAmount, 0)

  const partial = byId.get("ml-partial")!
  assert.equal(partial.grossAmount, 7_000)
  assert.equal(partial.netAmount, 6_000)
  // Una unidad devuelta recupera costo; la otra sigue vendida.
  assert.equal(partial.costAmount, 2_000)
  assert.equal(partial.profitAmount, 4_000)

  assert.equal(byId.get("ml-recovered")!.costAmount, 0)
  assert.equal(byId.get("ml-recovered")!.profitAmount, 0)
  assert.equal(byId.get("ml-lost")!.costAmount, 2_000)
  assert.equal(byId.get("ml-lost")!.profitAmount, -2_000)
})

test("NC parcial por envío + producto devuelto sin NC: los 10.000 pendientes se revierten y la NC posterior no duplica", () => {
  const base = order({ id: 5, total: 11_000, original_total: 11_000, invoice_status: "authorized" })
  const returned = item({ id: 51, orden_id: 5, producto_id: 1, precio: 10_000, costo_unitario_historico: 4_000, return_restocked_quantity: 1 })
  // NC identificada como envío original devuelto (original_shipping_refunded).
  const shippingNote = { id: "nc-envio", order_id: 5, total_amount: 1_000, manual_amount: 1_000, original_shipping_refunded: 1_000, authorized_at: "2026-10-04T12:00:00.000Z", order_credit_note_items: [] }

  const pendingProduct = ledger({ orders: [base], items: [returned], authorizedCreditNotes: [shippingNote] })
  assert.equal(pendingProduct.totals.reversals, 11_000)
  assert.equal(pendingProduct.totals.grossAmount, 0)
  assert.equal(pendingProduct.web.completedRefunds, 1_000)
  assert.equal(pendingProduct.web.pendingReturnAdjustment, 10_000)
  // La unidad volvió al stock: sin costo de mercadería.
  assert.equal(pendingProduct.totals.costOfGoodsSold, 0)

  const productNote = {
    id: "nc-producto", order_id: 5, total_amount: 10_000, manual_amount: 0, authorized_at: "2026-10-08T12:00:00.000Z",
    order_credit_note_items: [{ order_item_id: 51, quantity: 1, total_amount: 10_000 }],
  }
  const bothNotes = ledger({ orders: [base], items: [returned], authorizedCreditNotes: [shippingNote, productNote] })
  assert.equal(bothNotes.totals.reversals, 11_000)
  assert.equal(bothNotes.web.completedRefunds, 11_000)
  assert.equal(bothNotes.web.pendingReturnAdjustment, 0)

  // Reintegro económico del producto antes de su NC: mayor, no suma.
  const refundedProduct = ledger({
    orders: [{ ...base, financial_status: "refunded", refunded_at: "2026-10-07T12:00:00.000Z", refund_amount: 10_000 }],
    items: [returned],
    authorizedCreditNotes: [shippingNote],
  })
  assert.equal(refundedProduct.totals.reversals, 11_000)
  assert.equal(refundedProduct.web.ambiguousReversalOrders, 0)
})

test("NC sin ítem: A envío identificado suma, B NC vinculada no duplica, C sin atribuir queda Pendiente, D al vincularla se resuelve", () => {
  const base = order({ id: 7, total: 11_000, original_total: 11_000, invoice_status: "authorized" })
  const returned = item({ id: 71, orden_id: 7, producto_id: 1, precio: 10_000, costo_unitario_historico: 4_000, return_restocked_quantity: 1 })
  type Note = DashboardLedgerInput["authorizedCreditNotes"][number]
  const note = (fields: Pick<Note, "total_amount"> & Partial<Note>): Note => ({
    id: "nc-7", order_id: 7, manual_amount: 0, authorized_at: "2026-10-04T12:00:00.000Z", order_credit_note_items: [], ...fields,
  })

  // A. NC de envío identificada + producto devuelto: 1.000 + 10.000.
  const a = ledger({ orders: [base], items: [returned], authorizedCreditNotes: [note({ total_amount: 1_000, manual_amount: 1_000, original_shipping_refunded: 1_000 })] })
  assert.equal(a.totals.reversals, 11_000)
  assert.equal(a.totals.contributionResult, 0)
  assert.equal(a.web.ambiguousReversalOrders, 0)

  // B. NC vinculada al producto + la misma devolución física: 10.000, no 20.000.
  const b = ledger({
    orders: [base], items: [returned],
    authorizedCreditNotes: [note({ total_amount: 10_000, order_credit_note_items: [{ order_item_id: 71, quantity: 1, total_amount: 10_000 }] })],
  })
  assert.equal(b.totals.reversals, 10_000)
  assert.equal(b.totals.grossAmount, 1_000)
  assert.equal(b.totals.contributionResult, 1_000)
  assert.equal(b.web.ambiguousReversalOrders, 0)

  // C. NC sin ítem ni envío por 10.000 + devolución de 10.000: no se sabe si es la misma.
  // La facturación ajustada podría ser 1.000 (misma reversión) o 0 (distintas):
  // no se informa ninguna de las dos.
  const c = ledger({ orders: [base], items: [returned], authorizedCreditNotes: [note({ total_amount: 10_000, manual_amount: 10_000 })] })
  assert.equal(c.web.ambiguousReversalOrders, 1)
  assert.equal(c.totals.ambiguousReversalLines, c.sales.length)
  assert.ok(c.sales.every((sale) =>
    sale.reversalAmbiguous && sale.grossAmount === null && sale.reversalAmount === null &&
    sale.netAmount === null && sale.profitAmount === null && sale.marginPercent === null))
  assert.equal(c.totals.grossSales, 11_000, "el bruto original sí es conocido")
  assert.equal(c.totals.reversals, null)
  assert.equal(c.totals.grossAmount, null)
  assert.equal(c.totals.netSales, null)
  assert.equal(c.totals.contributionResult, null)
  assert.equal(c.totals.contributionMarginPercent, null)
  assert.equal(calculateOperatingResult(c.totals.contributionResult, 0), null)
  // Ni la devolución pendiente se informa como monto: sería una cota.
  assert.equal(c.web.pendingReturnAdjustment, 0)
  // El gráfico marca el tramo como no determinable en vez de sumar una cota.
  const [bucket] = buildSalesEvolution(c.sales, { from: "2026-10-01", to: "2026-10-01" }, "day")
  assert.deepEqual(bucket.undeterminedChannels, ["web"])
  assert.equal(bucket.total, 0)
  // D. Venta sana (10.000) + ambigua: el total no es 10.000 ni 11.000.
  const mixed = ledger({
    orders: [base, ...webNormal.orders], items: [returned, ...webNormal.items],
    authorizedCreditNotes: [note({ total_amount: 10_000, manual_amount: 10_000 })],
    marketplaceRows: [mlNormal],
  })
  assert.equal(mixed.totals.grossAmount, null)
  assert.equal(mixed.totals.netSales, null)
  assert.equal(mixed.totals.contributionResult, null)
  assert.equal(mixed.channels.web.grossAmount, null)
  assert.equal(mixed.channels.web.contributionResult, null)
  // Otro canal sin ambigüedad sigue siendo exacto.
  assert.equal(mixed.channels.marketplace.grossAmount, 10_000)
  assert.equal(mixed.channels.marketplace.contributionResult, 4_200)
  assert.equal(mixed.sales.find((sale) => sale.id === "web-11")?.grossAmount, 10_000)

  // D. La misma NC, ahora vinculada al ítem devuelto: deja de estar Pendiente.
  const d = ledger({
    orders: [base], items: [returned],
    authorizedCreditNotes: [note({ total_amount: 10_000, manual_amount: 0, order_credit_note_items: [{ order_item_id: 71, quantity: 1, total_amount: 10_000 }] })],
  })
  assert.equal(d.web.ambiguousReversalOrders, 0)
  assert.equal(d.totals.reversals, 10_000)
  assert.equal(d.totals.grossAmount, 1_000, "facturación numérica otra vez")
  assert.equal(d.totals.netSales, 1_000)
  assert.equal(d.totals.contributionResult, 1_000)
  // A con montos: NC de envío identificada → facturación 0 exacta.
  assert.equal(a.totals.grossAmount, 0)
  assert.equal(a.totals.netSales, 0)
})

test("devolución física sin NC en una orden sin otra reversión sigue restándose", () => {
  const { totals, web } = ledger({
    orders: [order({ id: 6, total: 20_000, original_total: 20_000 })],
    items: [item({ id: 61, orden_id: 6, producto_id: 1, cantidad: 2, precio: 10_000, costo_unitario_historico: 4_000, return_restocked_quantity: 1 })],
  })
  assert.equal(totals.reversals, 10_000)
  assert.equal(web.pendingReturnAdjustment, 10_000)
  assert.equal(totals.costOfGoodsSold, 4_000)
  assert.equal(totals.contributionResult, 6_000)
})

test("ML: reembolso parcial sin return_units conserva el COGS; return_units y revisión física lo recuperan", () => {
  const parsed = { status: "Reembolso parcial", cancellations_refunds: -3_000 }
  const { sales } = ledger({
    marketplaceRows: [
      mlRow({ id: "a", quantity: 2, gross_amount: 10_000, net_amount: 7_000, costo_unitario_historico: 2_000, raw_data: { parsed } }),
      mlRow({ id: "b", quantity: 2, gross_amount: 10_000, net_amount: 7_000, costo_unitario_historico: 2_000, raw_data: { parsed: { ...parsed, return_units: 1 } } }),
      mlRow({ id: "c", quantity: 2, gross_amount: 10_000, net_amount: 7_000, costo_unitario_historico: 2_000, raw_data: { parsed } }),
    ],
    marketplaceReturnReviews: [
      { mercadolibre_sale_id: "c", sellable_quantity: 2, discounted_quantity: 0, non_sellable_quantity: 0 },
    ],
  })
  const byId = new Map(sales.map((sale) => [sale.id, sale]))
  assert.equal(byId.get("ml-a")!.costAmount, 4_000)
  assert.equal(byId.get("ml-a")!.profitAmount, 3_000)
  assert.equal(byId.get("ml-b")!.costAmount, 2_000)
  assert.equal(byId.get("ml-c")!.costAmount, 0)
})

test("ML: reembolso total con tracking no recupera COGS; return_units y revisión física sí", () => {
  const refundedReturn = { status: "Devolución finalizada", cancellations_refunds: -10_000, return_tracking_number: "TRK-1", return_result: "Entregada al vendedor" }
  const row = (id: string, parsed: Record<string, unknown>) =>
    mlRow({ id, quantity: 2, gross_amount: 10_000, fee_amount: 1_000, net_amount: -1_000, costo_unitario_historico: 2_000, raw_data: { parsed } })
  const { sales } = ledger({
    marketplaceRows: [
      row("tracking", refundedReturn),
      row("units", { ...refundedReturn, return_units: 1 }),
      row("mixed", refundedReturn),
      row("sellable", refundedReturn),
    ],
    marketplaceReturnReviews: [
      { mercadolibre_sale_id: "mixed", sellable_quantity: 1, discounted_quantity: 0, non_sellable_quantity: 1 },
      { mercadolibre_sale_id: "sellable", sellable_quantity: 2, discounted_quantity: 0, non_sellable_quantity: 0 },
    ],
  })
  const byId = new Map(sales.map((sale) => [sale.id, sale]))
  // A/E. Sin cantidad ni revisión: el costo de las 2 unidades sigue sin recuperarse.
  assert.equal(byId.get("ml-tracking")!.costAmount, 4_000)
  assert.equal(byId.get("ml-tracking")!.profitAmount, -5_000)
  // B. return_units = 1.
  assert.equal(byId.get("ml-units")!.costAmount, 2_000)
  assert.equal(byId.get("ml-units")!.profitAmount, -3_000)
  // C. 1 vendible + 1 dañada: se recupera sólo 1.
  assert.equal(byId.get("ml-mixed")!.costAmount, 2_000)
  // D. 2 vendibles: se recupera todo.
  assert.equal(byId.get("ml-sellable")!.costAmount, 0)
  assert.equal(byId.get("ml-sellable")!.profitAmount, -1_000)
})

test("ML: Dashboard y pantalla Ventas ML resuelven las mismas unidades costeables", async () => {
  const refundedReturn = { status: "Devolución finalizada", cancellations_refunds: -10_000, return_tracking_number: "TRK-1" }
  const cases = [
    { id: "full-review", parsed: refundedReturn, review: { sellable_quantity: 2, discounted_quantity: 0, non_sellable_quantity: 0 }, units: 0, cost: 0 },
    { id: "partial-review", parsed: refundedReturn, review: { sellable_quantity: 1, discounted_quantity: 0, non_sellable_quantity: 1 }, units: 1, cost: 2_000 },
    { id: "return-units", parsed: { ...refundedReturn, return_units: 1 }, review: null, units: 1, cost: 2_000 },
    { id: "no-evidence", parsed: refundedReturn, review: null, units: 2, cost: 4_000 },
    { id: "cancelled", parsed: { status: "Cancelada por el comprador", cancellations_refunds: -10_000 }, review: null, units: 0, cost: 0 },
  ]
  const rows = cases.map(({ id, parsed }) =>
    mlRow({ id, quantity: 2, gross_amount: 10_000, net_amount: 0, costo_unitario_historico: 2_000, raw_data: { parsed } }))
  const reviews = cases.flatMap(({ id, review }) => (review ? [{ mercadolibre_sale_id: id, ...review }] : []))
  const { sales } = ledger({ marketplaceRows: rows, marketplaceReturnReviews: reviews })

  for (const [index, expected] of cases.entries()) {
    const line = sales.find((sale) => sale.id === `ml-${expected.id}`)!
    // Lo mismo que calcula app/api/admin/mercadolibre-sales para su columna de costo.
    const screenUnits = getMercadoLibreCostableUnits(rows[index], toMercadoLibrePhysicalReview(expected.review))
    assert.equal(screenUnits, expected.units, `${expected.id}: pantalla ML`)
    assert.equal(line.costableUnits, screenUnits, `${expected.id}: unidades costeables`)
    assert.equal(line.quantity, screenUnits, `${expected.id}: cantidad visible`)
    assert.equal(line.costAmount, expected.cost, `${expected.id}: COGS`)
  }

  // Ninguno de los dos llama a la resolución sin la revisión física.
  const { readFileSync } = await import("node:fs")
  const screenRoute = readFileSync("app/api/admin/mercadolibre-sales/route.ts", "utf8")
  const ledgerSource = readFileSync("lib/business/dashboard-commercial-ledger.ts", "utf8")
  assert.match(screenRoute, /getMercadoLibreCostableUnits\(\s*row,\s*toMercadoLibrePhysicalReview\(returnReview\),?\s*\)/)
  assert.match(ledgerSource, /toMercadoLibrePhysicalReview\(review\)/)
  for (const source of [screenRoute, ledgerSource]) {
    assert.doesNotMatch(source, /getMercadoLibreCostableUnits\(row\)/)
  }
})

test("gasto tipo producto sin costo marca el día; con costo no", () => {
  const productExpense = { amount: 0, status: "pagado" as const, expense_type: "product" as const, variant_id: null, quantity: 2 }
  const result = ledger({
    productCosts: [{ id: "cost-1", article_name: "Auriculares", sku: null, product_id: 1, variant_id: null, purchase_date: "2026-09-01", quantity: 10, received_quantity: 10, reception_status: "recibida", total_cost: 10_000 }],
    expenses: [
      { ...productExpense, expense_date: "2026-10-10", product_id: 99 },
      { ...productExpense, expense_date: "2026-10-11", product_id: 1 },
    ],
  })
  assert.deepEqual(result.expenses.paidByDate, [
    { date: "2026-10-10", amount: 0, costMissing: true },
    { date: "2026-10-11", amount: 2_000, costMissing: false },
  ])
  assert.ok(result.expenses.coveredUnits < result.expenses.costableUnits)
})

test("agregado real: Web, ML y Externa con la misma semántica y sin descuentos dobles", () => {
  const result = ledger({
    ...webNormal,
    marketplaceRows: [mlNormal],
    externalRows: [externalHistorical],
    expenses: [
      { expense_date: "2026-10-10", amount: 1_000, status: "pagado", expense_type: "money", product_id: null, variant_id: null, quantity: null },
      { expense_date: "2026-10-11", amount: 500, status: "pendiente", expense_type: "money", product_id: null, variant_id: null, quantity: null },
    ],
  })
  const expected = {
    web: { grossSales: 10_000, netSales: 8_900, fees: 300, shippingCost: 800, costOfGoodsSold: 4_000, contributionResult: 4_900 },
    marketplace: { grossSales: 10_000, netSales: 8_200, fees: 1_500, shippingCost: 500, costOfGoodsSold: 4_000, contributionResult: 4_200 },
    external: { grossSales: 10_000, netSales: 9_000, fees: 500, shippingCost: 300, costOfGoodsSold: 5_000, contributionResult: 4_000 },
  } as const
  for (const [channel, values] of Object.entries(expected)) {
    const totals = result.channels[channel as keyof typeof expected]
    for (const [key, value] of Object.entries(values)) {
      assert.equal(totals[key as keyof typeof values], value, `${channel}.${key}`)
    }
    assert.equal(totals.contributionMarginPercent, (values.contributionResult / values.grossSales) * 100)
  }

  const { totals } = result
  assert.equal(totals.grossSales, 30_000)
  assert.equal(totals.netSales, 26_100)
  assert.equal(totals.costOfGoodsSold, 13_000)
  assert.equal(totals.contributionResult, 13_100)
  assert.equal(totals.reversals, 0)
  // Cada concepto se resta una sola vez: bruto − reversiones − comisiones −
  // logística − otros = ventas netas, y resultado = neto − costo.
  assert.equal(
    totals.grossSales - totals.reversals - totals.fees - totals.shippingCost - totals.otherCosts,
    totals.netSales,
  )
  assert.equal(totals.netSales - totals.costOfGoodsSold, totals.contributionResult)
  // Gastos: sólo los pagados restan; los pendientes se informan aparte.
  assert.equal(result.expenses.paid, 1_000)
  assert.equal(result.expenses.pending, 500)
  assert.deepEqual(result.expenses.paidByDate, [{ date: "2026-10-10", amount: 1_000, costMissing: false }])
  assert.equal(calculateOperatingResult(totals.contributionResult, result.expenses.paid), 12_100)
  // El panel comercial suma las mismas líneas: misma cifra que el resumen.
  assert.equal(summarizeSaleFinancials(result.sales).netSales, totals.netSales)
})
