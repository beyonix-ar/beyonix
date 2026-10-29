import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act, createElement } from "react"

import type { SupabasePedido, SupabasePedidoItem } from "../supabase/types"
import type { DashboardFinancialSummary } from "../supabase/queries/dashboard"
import {
  buildDashboardLedger,
  type DashboardLedgerInput,
  type ExpenseRow,
} from "../business/dashboard-commercial-ledger"

const DAY = 86_400_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const dateKeyDaysAgo = (days: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(Date.now() - days * DAY))

const moneyExpense = (days: number, amount: number): ExpenseRow => ({
  expense_date: dateKeyDaysAgo(days), amount, status: "pagado", expense_type: "money", product_id: null, variant_id: null, quantity: null,
})

// Venta web de hace 2 días (dentro de "Últimos 30 días") y venta ML de hace
// 200 días (fuera): el período no puede mezclarlas.
function buildLedger(expenses: ExpenseRow[], extra: Partial<Pick<DashboardLedgerInput, "orders" | "items" | "authorizedCreditNotes">> = {}) {
  return buildDashboardLedger({
    orders: [...(extra.orders ?? []), {
      id: 1,
      estado: "pagado",
      total: 10_000,
      original_total: 10_000,
      paid_at: daysAgo(2),
      created_at: daysAgo(2),
      mercadopago_payment_snapshot: { transaction_amount: 10_000, transaction_details: { net_received_amount: 9_700 } },
      shipping_provider_quote_amount: 800,
    } as SupabasePedido],
    items: [...(extra.items ?? []), {
      id: 11,
      orden_id: 1,
      producto_id: 1,
      variante_id: null,
      cantidad: 1,
      precio: 10_000,
      costo_unitario_historico: 4_000,
      productos: { id: 1, nombre: "Auriculares", categorias: { nombre: "Audio" } },
    } as SupabasePedidoItem],
    authorizedCreditNotes: extra.authorizedCreditNotes ?? [],
    creditMovements: [],
    marketplaceRows: [{
      id: "ml-old",
      sale_date: daysAgo(200),
      quantity: 1,
      gross_amount: 10_000,
      fee_amount: 1_500,
      shipping_amount: 500,
      net_amount: 8_200,
      costo_unitario_historico: 4_000,
      raw_data: { parsed: { status: "Entregada" } },
    }],
    marketplaceReturnReviews: [],
    externalRows: [],
    productCosts: [],
    expenses,
  })
}

function buildSummary(ledger: ReturnType<typeof buildLedger>, overrides: Partial<DashboardFinancialSummary> = {}) {
  const { totals } = ledger
  return {
    webGrossSales: 10_000, marketplaceGrossSales: 10_000, externalGrossSales: 0,
    grossSales: totals.grossSales, completedRefunds: 0, pendingRefunds: 0, pendingReturnAdjustment: 0,
    billedSales: totals.grossAmount, netSales: totals.netSales, webNetSales: 8_900, marketplaceNet: 8_200, externalNet: 0,
    externalCollected: 10_000, customerCreditUsed: 0, shippingCharged: 0, shippingCost: totals.shippingCost,
    shippingBalance: -800, transferDiscounts: 0, webMercadoPagoFees: 300, marketplaceFees: 1_500,
    marketplaceRefunds: 0, marketplaceShipping: 500, salesFees: totals.fees, otherDirectCosts: totals.otherCosts,
    inventoryPurchases: 0, costOfGoodsSold: totals.costOfGoodsSold, contributionResult: totals.contributionResult,
    operatingExpensesPaid: ledger.expenses.paid, productExpenseEconomicCost: 0, operatingExpensesPending: 0,
    operatingResult: (totals.contributionResult ?? 0) - ledger.expenses.paid, operatingMarginPercent: 0,
    costCoveragePercent: 100, inferredCostPercent: 0, invoicedAmount: 0, paidOrders: 1, invoicedOrders: 0,
    ordersWithPaymentMismatch: 0, ordersMissingShippingCost: 0, ordersWithoutInvoice: 1, invoiceErrors: 0,
    creditNotesPending: 0, negativeStockItems: 0, ordersScanned: 1, marketplaceRowsScanned: 1, externalRowsScanned: 0,
    complete: true, generatedAt: new Date().toISOString(), warnings: [],
    ...overrides,
  } satisfies DashboardFinancialSummary
}

async function renderView(
  ledger: ReturnType<typeof buildLedger>,
  summary: DashboardFinancialSummary,
  inspect: (helpers: { kpi: (label: string) => { value: string; detail: string } }) => void,
) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  dom.window.localStorage.setItem("beyonix-hide-dashboard-values", "false")

  const { DashboardCommercialView } = await import("../../app/admin/sections/dashboard/dashboard-commercial")
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime")
  const { createRoot } = await import("react-dom/client")
  const root = createRoot(document.getElementById("root")!)
  const router = { bfcacheId: "test-router", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} }
  const kpi = (label: string) => {
    const card = [...document.querySelectorAll(".admin-dashboard-kpi")].find((node) => node.querySelector("p")?.textContent?.trim() === label)
    assert.ok(card, `KPI ${label}`)
    const paragraphs = card.querySelectorAll("p")
    return { value: paragraphs[1]?.textContent ?? "", detail: paragraphs[2]?.textContent ?? "" }
  }

  try {
    await act(async () => {
      root.render(
        createElement(
          AppRouterContext.Provider,
          { value: router },
          createElement(DashboardCommercialView, {
            sales: ledger.sales,
            paidExpensesByDate: ledger.expenses.paidByDate,
            financialSummary: summary,
            pendingRefundOperations: 0,
          }),
        ),
      )
    })
    inspect({ kpi })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}

test("panel comercial: facturación, neto, costo y resultado responden al mismo período; el histórico se rotula aparte", async () => {
  const ledger = buildLedger([moneyExpense(5, 1_000), moneyExpense(300, 9_000)])
  await renderView(ledger, buildSummary(ledger), ({ kpi }) => {
    assert.match(kpi("Facturación").value, /10\.000/)
    assert.match(kpi("Ventas netas").value, /8\.900/)
    assert.match(kpi("Costo mercadería").value, /4\.000/)
    assert.match(kpi("Costo mercadería").detail, /100,0% con costo/)
    assert.match(kpi("Resultado comercial").value, /4\.900/)
    // Sólo el gasto del período (1.000), no el de hace 300 días.
    assert.match(kpi("Ganancia limpia").value, /3\.900/)

    const text = document.body.textContent ?? ""
    assert.match(text, /Histórico/)
    assert.match(text, /No responde a los filtros de arriba/)
    assert.match(text, /Ventas con factura/)
    assert.doesNotMatch(text, /Ganancia real|Facturado ARCA|Resultado bruto/)
    const headers = [...document.querySelectorAll("thead th")].map((node) => node.textContent?.trim())
    assert.deepEqual(headers.slice(4, 8), ["Facturación", "Neto", "Costo mercadería", "Resultado"])
  })
})

test("panel comercial: con lectura incompleta no reconstruye resultados ni muestra cobertura", async () => {
  // Las líneas que llegaron son calculables, pero el backend avisa que faltan datos.
  const ledger = buildLedger([moneyExpense(5, 1_000)])
  const summary = buildSummary(ledger, { complete: false, contributionResult: null, operatingResult: null })
  await renderView(ledger, summary, ({ kpi }) => {
    assert.equal(kpi("Resultado comercial").value, "Pendiente")
    assert.equal(kpi("Resultado comercial").detail, "Lectura incompleta")
    assert.equal(kpi("Ganancia limpia").value, "Pendiente")
    assert.equal(kpi("Costo mercadería").detail, "Lectura incompleta")
    assert.doesNotMatch(document.body.textContent ?? "", /100,0% con costo/)
  })
})

// Pedido #2: producto 10.000 + envío 1.000, producto devuelto físicamente.
function returnedOrderLedger(note: DashboardLedgerInput["authorizedCreditNotes"][number]) {
  return buildLedger([moneyExpense(5, 1_000)], {
    orders: [{ id: 2, estado: "pagado", total: 11_000, original_total: 11_000, paid_at: daysAgo(3), created_at: daysAgo(3), invoice_status: "authorized" } as SupabasePedido],
    items: [{
      id: 21, orden_id: 2, producto_id: 1, variante_id: null, cantidad: 1, precio: 10_000, costo_unitario_historico: 4_000,
      return_restocked_quantity: 1, productos: { id: 1, nombre: "Auriculares", categorias: { nombre: "Audio" } },
    } as SupabasePedidoItem],
    authorizedCreditNotes: [note],
  })
}

test("panel comercial: venta sana + NC sin atribuir con devolución sin NC → facturación y rentabilidad Pendiente, también en el histórico", async () => {
  const ledger = returnedOrderLedger({ id: "nc-2", order_id: 2, total_amount: 10_000, manual_amount: 10_000, authorized_at: daysAgo(1), order_credit_note_items: [] })
  const { totals } = ledger
  assert.equal(totals.grossAmount, null)
  const summary = buildSummary(ledger, {
    billedSales: totals.grossAmount, netSales: totals.netSales, webNetSales: ledger.channels.web.netSales,
    contributionResult: null, operatingResult: null, operatingMarginPercent: null,
  })
  await renderView(ledger, summary, ({ kpi }) => {
    // Ni 10.000 (sólo la sana) ni 11.000 (con la cota): no es determinable.
    assert.equal(kpi("Facturación").value, "Pendiente")
    assert.equal(kpi("Facturación").detail, "Hay una devolución sin atribuir.")
    assert.equal(kpi("Ticket promedio").value, "Pendiente")
    assert.equal(kpi("Ventas netas").value, "Pendiente")
    assert.equal(kpi("Resultado comercial").value, "Pendiente")
    assert.equal(kpi("Resultado comercial").detail, "Devolución sin atribuir")
    assert.equal(kpi("Ganancia limpia").value, "Pendiente")
    // Operaciones y unidades no dependen del monto revertido.
    assert.equal(kpi("Operaciones").value, "2")

    const text = document.body.textContent ?? ""
    assert.doesNotMatch(text, /\$\s?11\.000/)
    // Histórico: misma regla que el período.
    const historic = (label: string) => {
      const card = [...document.querySelectorAll(".admin-dashboard-financial-metric")]
        .find((node) => node.querySelector("p span")?.textContent?.trim() === label)
      assert.ok(card, `métrica histórica ${label}`)
      return card.querySelectorAll("p")[1]?.textContent ?? ""
    }
    assert.equal(historic("Ventas netas"), "Pendiente")
    assert.equal(historic("Resultado comercial"), "Pendiente")
    assert.equal(historic("Ganancia limpia"), "Pendiente")
    assert.equal(historic("Margen estimado"), "Pendiente")
  })
})

test("panel comercial: con la NC atribuible (al producto o al envío) la facturación vuelve a ser numérica", async () => {
  const linked = returnedOrderLedger({
    id: "nc-2", order_id: 2, total_amount: 10_000, manual_amount: 0, authorized_at: daysAgo(1),
    order_credit_note_items: [{ order_item_id: 21, quantity: 1, total_amount: 10_000 }],
  })
  await renderView(linked, buildSummary(linked), ({ kpi }) => {
    // 10.000 de la venta sana + 1.000 (envío no revertido).
    assert.match(kpi("Facturación").value, /11\.000/)
    assert.notEqual(kpi("Resultado comercial").value, "Pendiente")
  })

  const shipping = returnedOrderLedger({
    id: "nc-2", order_id: 2, total_amount: 1_000, manual_amount: 1_000, original_shipping_refunded: 1_000,
    authorized_at: daysAgo(1), order_credit_note_items: [],
  })
  await renderView(shipping, buildSummary(shipping), ({ kpi }) => {
    // 10.000 de la venta sana + 0 (envío por NC + producto devuelto).
    assert.match(kpi("Facturación").value, /10\.000/)
    assert.notEqual(kpi("Resultado comercial").value, "Pendiente")
  })
})

test("panel comercial: mercadería entregada como gasto sin costo deja Pendiente la ganancia limpia", async () => {
  const ledger = buildLedger([
    { expense_date: dateKeyDaysAgo(3), amount: 0, status: "pagado", expense_type: "product", product_id: 99, variant_id: null, quantity: 1 },
  ])
  await renderView(ledger, buildSummary(ledger, { operatingResult: null }), ({ kpi }) => {
    // La venta tiene costo: el resultado comercial sigue siendo válido.
    assert.match(kpi("Resultado comercial").value, /4\.900/)
    assert.equal(kpi("Ganancia limpia").value, "Pendiente")
    assert.equal(kpi("Ganancia limpia").detail, "Falta costo de mercadería entregada como gasto")
  })
})
