/**
 * Agregado financiero del Dashboard: convierte pedidos web, ventas de
 * Mercado Libre y ventas externas en líneas comerciales con la semántica de
 * commercial-sale-financials.ts. Es la única fuente de las cifras: el
 * resumen histórico suma estas mismas líneas y el panel comercial las filtra
 * por período, así ningún KPI usa una fórmula distinta para el mismo concepto.
 * Sin llamadas a Supabase, para poder testear el agregado real.
 */

import type { SupabasePedido, SupabasePedidoItem } from "../supabase/types.ts"
import {
  getMercadoLibreCostableUnits,
  getMercadoLibreCostMapping,
  getMercadoLibreRefundAmount,
  toMercadoLibrePhysicalReview,
  type MercadoLibrePhysicalReview,
} from "../mercadolibre/sale-costing.ts"
import {
  buildSaleFinancials,
  getCoveragePercent,
  summarizeSaleFinancials,
  type SaleCostSource,
  type SaleFinancials,
  type SaleFinancialTotals,
} from "./commercial-sale-financials.ts"
import {
  calculatePendingRefundAdjustment,
  getCustomerCreditRestoredOutsideCreditNotes,
  getMercadoPagoFeeAmount,
  getOrderReversalWithPendingReturns,
  getOrderRevenueReversal,
  getProductExpenseEconomicCost,
  getUnattributedCreditNoteAmount,
  type OrderRevenueReversal,
} from "./dashboard-financials.ts"
import {
  getExternalSaleMerchandiseCost,
  resolveExternalSaleReportedProfitability,
  resolveExternalSaleUnitCost,
} from "./external-sale-profitability.ts"
import {
  buildProductCostLedgers,
  getHistoricalUnitCost,
  getReceivedCostContribution,
  resolveReportedUnitCost,
} from "./product-costs.ts"
import {
  getStandaloneHistoricalUnitCost,
  type StandaloneCostRow,
} from "./standalone-cost-items.ts"

export type CommercialSaleChannel =
  | "BEYONIX Web"
  | "MercadoLibre Marketplace"
  | "Ventas externas"

export interface CommercialSale extends SaleFinancials {
  id: string
  date: string
  channel: CommercialSaleChannel
  /** adjustment: reversión a nivel pedido sin ítem (NC general, envío, reintegro manual). */
  kind: "sale" | "adjustment"
  paymentMethod: string
  productName: string
  categoryName: string | null
  sku: string | null
  quantity: number
  orderId: string | null
}

export interface CreditMovementRow {
  order_id: number
  amount: number | string
  movement_type: "debit" | "reversal"
}

export interface ProductCostRow extends StandaloneCostRow {
  variant_id: number | null
}

export interface ExpenseRow {
  expense_date: string
  amount: number
  status: "pendiente" | "pagado"
  expense_type: "money" | "product" | null
  product_id: number | null
  variant_id: number | null
  quantity: number | null
}

export interface MercadoLibreReturnReviewRow {
  mercadolibre_sale_id: string
  sellable_quantity: number
  discounted_quantity: number
  non_sellable_quantity: number
}

export interface AuthorizedCreditNoteRow {
  id: string
  order_id: number
  total_amount: number | string
  manual_amount: number | string
  /** Parte del saldo usado que restituye la NC (incluida en total_amount). */
  customer_credit_amount?: number | string | null
  /** Envío original devuelto por la NC (incluido en manual_amount). */
  original_shipping_refunded?: number | string | null
  authorized_at: string | null
  order_credit_note_items?: Array<{
    order_item_id: number
    quantity: number
    total_amount: number | string
  }>
}

export interface DashboardLedgerInput {
  /** Pedidos web que fueron venta cobrada (isDashboardPaidSale). */
  orders: SupabasePedido[]
  items: SupabasePedidoItem[]
  authorizedCreditNotes: AuthorizedCreditNoteRow[]
  creditMovements: CreditMovementRow[]
  marketplaceRows: Array<Record<string, unknown>>
  marketplaceReturnReviews: MercadoLibreReturnReviewRow[]
  /** Todas las ventas externas, incluidas las revertidas. */
  externalRows: Array<Record<string, unknown>>
  productCosts: ProductCostRow[]
  expenses: ExpenseRow[]
}

export interface PaidExpenseDay {
  date: string
  amount: number
  costMissing: boolean
}

export interface DashboardLedger {
  sales: CommercialSale[]
  totals: SaleFinancialTotals
  channels: Record<"web" | "marketplace" | "external", SaleFinancialTotals>
  web: {
    completedRefunds: number
    pendingRefunds: number
    /** Ítems recibidos en devolución todavía sin NC (ya restados del neto). */
    pendingReturnAdjustment: number
    mercadoPagoFees: number
    shippingCost: number
    shippingCharged: number
    transferDiscounts: number
    externalCollected: number
    customerCreditUsed: number
    ordersWithoutItems: number
    /** Pedidos con NC sin atribuir + devolución física sin NC (resultado pendiente). */
    ambiguousReversalOrders: number
  }
  marketplace: { fees: number; shipping: number; refunds: number }
  external: { damagedReturnReversals: number; inconsistentProfitSales: number }
  expenses: {
    paid: number
    pending: number
    productEconomicCost: number
    costableUnits: number
    coveredUnits: number
    /**
     * Gastos pagados + costo económico de gastos tipo producto, por día.
     * costMissing: ese día hay mercadería entregada como gasto sin costo
     * determinable, así que su resultado no puede calcularse.
     */
    paidByDate: PaidExpenseDay[]
  }
  inventoryPurchases: number
  /** Cobertura de costo de ventas + gastos tipo producto. */
  costCoveragePercent: number
}

function amount(value: unknown) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function positiveId(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function addTo(map: Map<number, number>, key: number, value: number) {
  map.set(key, (map.get(key) ?? 0) + value)
}

function reportedCost(
  snapshot: unknown,
  dynamic: number | null,
): { unitCost: number | null; source: SaleCostSource } {
  const frozen = snapshot == null || snapshot === "" ? null : Number(snapshot)
  const valid = frozen != null && Number.isFinite(frozen) ? frozen : null
  const unitCost = resolveReportedUnitCost(valid, dynamic)
  return {
    unitCost,
    source: valid != null ? "snapshot" : unitCost != null ? "historical" : "missing",
  }
}

function lineCost(unitCost: number | null, source: SaleCostSource, costableUnits: number) {
  if (costableUnits === 0) return { costAmount: 0, costSource: "none" as const }
  return unitCost == null
    ? { costAmount: null, costSource: "missing" as const }
    : { costAmount: unitCost * costableUnits, costSource: source }
}

function getPaymentMethodLabel(order: SupabasePedido) {
  if (order.payment_method_id === "mercadopago" || order.payment_id) {
    return "Mercado Pago"
  }
  if (order.payment_method_id === "transferencia") return "Transferencia"
  return order.payment_method_id || order.payment_type_id || "No informado"
}

/**
 * Costo logístico web = tarifa de Andreani cotizada (snapshot de la orden).
 * shipping_cost_real incluye recargo logístico y ajuste comercial: usarlo
 * inflaría el costo. Órdenes previas al snapshot conservan el dato anterior.
 */
function getWebShippingCost(order: SupabasePedido) {
  return amount(
    order.shipping_provider_quote_amount ?? order.shipping_cost_real ?? order.andreani_costo,
  )
}

export function buildDashboardLedger(input: DashboardLedgerInput): DashboardLedger {
  const costLedgers = buildProductCostLedgers(input.productCosts)
  const sales: CommercialSale[] = []

  // ---- Web -----------------------------------------------------------
  const itemsByOrder = new Map<number, SupabasePedidoItem[]>()
  for (const item of input.items) {
    const rows = itemsByOrder.get(item.orden_id) ?? []
    rows.push(item)
    itemsByOrder.set(item.orden_id, rows)
  }

  const creditByOrder = new Map<number, number>()
  const unattributedCreditByOrder = new Map<number, number>()
  const creditNoteCustomerCreditByOrder = new Map<number, number>()
  const creditByItem = new Map<number, number>()
  const creditedQuantityByItem = new Map<number, number>()
  for (const note of input.authorizedCreditNotes) {
    addTo(creditByOrder, note.order_id, amount(note.total_amount))
    addTo(unattributedCreditByOrder, note.order_id, getUnattributedCreditNoteAmount(note))
    addTo(creditNoteCustomerCreditByOrder, note.order_id, amount(note.customer_credit_amount))
    for (const item of note.order_credit_note_items ?? []) {
      addTo(creditByItem, item.order_item_id, amount(item.total_amount))
      addTo(creditedQuantityByItem, item.order_item_id, amount(item.quantity))
    }
  }

  // Saldo a favor desde sus movimientos: 'debit' = aplicado al comprar,
  // 'reversal' = restituido (credit_balance_used baja a 0 al restituir).
  const restoredCreditByOrder = new Map<number, number>()
  const appliedCreditByOrder = new Map<number, number>()
  for (const movement of input.creditMovements) {
    const target = movement.movement_type === "debit" ? appliedCreditByOrder : restoredCreditByOrder
    addTo(target, Number(movement.order_id), Math.abs(amount(movement.amount)))
  }

  const web = {
    completedRefunds: 0,
    pendingRefunds: 0,
    pendingReturnAdjustment: 0,
    mercadoPagoFees: 0,
    shippingCost: 0,
    shippingCharged: 0,
    transferDiscounts: 0,
    externalCollected: 0,
    customerCreditUsed: 0,
    ordersWithoutItems: 0,
    ambiguousReversalOrders: 0,
  }

  for (const order of input.orders) {
    // Sólo el saldo restituido fuera de una NC: la NC ya lo incluye.
    const restoredCreditOutsideCreditNotes = getCustomerCreditRestoredOutsideCreditNotes(
      restoredCreditByOrder.get(order.id) ?? 0,
      creditNoteCustomerCreditByOrder.get(order.id) ?? 0,
    )
    const reversal: OrderRevenueReversal = getOrderRevenueReversal(
      { ...order, customer_credit_restored_amount: restoredCreditOutsideCreditNotes },
      creditByOrder.get(order.id) ?? 0,
    )
    if (reversal.status === "completed") web.completedRefunds += reversal.amount
    if (reversal.status === "pending") web.pendingRefunds += reversal.amount

    // Comisión real de Mercado Pago (snapshot del webhook): se mantiene aunque
    // la venta se reintegre, MP no la devuelve.
    const fee = getMercadoPagoFeeAmount(order.mercadopago_payment_snapshot)
    const shippingCost = getWebShippingCost(order)
    web.mercadoPagoFees += fee
    web.shippingCost += shippingCost
    web.shippingCharged += amount(order.shipping_cost_charged)
    // El descuento por transferencia ya está dentro de original_total: se
    // informa, nunca se vuelve a restar.
    web.transferDiscounts += amount(order.transfer_discount_amount)
    web.externalCollected += amount(
      order.external_amount_due ??
        order.payment_confirmed_amount ??
        Math.max(amount(order.total) - amount(order.credit_balance_used), 0),
    )
    web.customerCreditUsed +=
      appliedCreditByOrder.get(order.id) ?? amount(order.credit_balance_used)

    const date = order.paid_at ?? order.created_at
    const orderItems = itemsByOrder.get(order.id) ?? []
    const rawOrderAmount = orderItems.reduce(
      (total, item) => total + amount(item.cantidad) * amount(item.precio),
      0,
    )
    // Total final cobrado: ya incluye descuentos, envío cobrado y recargos.
    const orderGross = amount(order.original_total ?? order.total ?? rawOrderAmount)

    if (!orderItems.length) {
      web.ordersWithoutItems += 1
      sales.push({
        id: `web-order-${order.id}`,
        date,
        channel: "BEYONIX Web",
        kind: "sale",
        paymentMethod: getPaymentMethodLabel(order),
        productName: `Pedido #${order.id} sin detalle`,
        categoryName: null,
        sku: null,
        quantity: 0,
        orderId: String(order.id),
        ...buildSaleFinancials({
          grossSales: orderGross,
          reversalAmount: reversal.amount,
          feeAmount: fee,
          shippingCost,
          costableUnits: 0,
          costAmount: null,
          costSource: "missing",
        }),
      })
      continue
    }

    let itemReversalApplied = 0
    let pendingReturnTotal = 0
    // Las líneas se arman después de conciliar la orden: si su reversión es
    // ambigua, ninguna línea del pedido puede informar resultado.
    const orderLines: Array<{
      line: Omit<CommercialSale, keyof SaleFinancials>
      financials: Parameters<typeof buildSaleFinancials>[0]
    }> = []
    orderItems.forEach((item) => {
      const quantity = Math.max(amount(item.cantidad), 0)
      const restockedQuantity = Math.min(quantity, Math.max(amount(item.return_restocked_quantity), 0))
      const writtenOffQuantity = Math.min(
        Math.max(0, quantity - restockedQuantity),
        Math.max(amount(item.return_written_off_quantity), 0),
      )
      const costableUnits = Math.max(0, quantity - restockedQuantity)
      const creditedQuantity = Math.min(quantity, creditedQuantityByItem.get(item.id) ?? 0)
      const weight =
        rawOrderAmount > 0
          ? (quantity * amount(item.precio)) / rawOrderAmount
          : 1 / orderItems.length
      const allocatedGross = weight * orderGross
      const itemCredit = Math.min(allocatedGross, creditByItem.get(item.id) ?? 0)
      // Recibido en devolución pero todavía sin NC: deja de ser ingreso ya.
      // Cuánto de eso ya cubre un reintegro de la orden se concilia abajo.
      const pendingReturn = Math.min(
        allocatedGross - itemCredit,
        calculatePendingRefundAdjustment({
          unitPrice: amount(item.precio),
          receivedQuantity: restockedQuantity + writtenOffQuantity,
          creditedQuantity,
        }),
      )
      pendingReturnTotal += pendingReturn
      const itemReversal = itemCredit + pendingReturn
      itemReversalApplied += itemReversal

      const dynamicUnitCost = getHistoricalUnitCost(
        costLedgers,
        item.producto_id,
        item.variante_id,
        date,
      )
      const { unitCost, source } = reportedCost(item.costo_unitario_historico, dynamicUnitCost)
      const product = item.productos as
        | { nombre?: string | null; categorias?: { nombre?: string | null } | null }
        | null
        | undefined

      orderLines.push({
        line: {
          id: `web-${item.id}`,
          date,
          channel: "BEYONIX Web",
          kind: "sale",
          paymentMethod: getPaymentMethodLabel(order),
          productName: product?.nombre ?? `Producto #${item.producto_id}`,
          categoryName: product?.categorias?.nombre ?? null,
          sku: null,
          quantity: Math.max(0, quantity - creditedQuantity),
          orderId: String(order.id),
        },
        financials: {
          grossSales: allocatedGross,
          reversalAmount: itemReversal,
          feeAmount: fee * weight,
          shippingCost: shippingCost * weight,
          costableUnits,
          ...lineCost(unitCost, source, costableUnits),
        },
      })
    })

    const orderReversal = getOrderReversalWithPendingReturns({
      reversal,
      authorizedCreditAmount: creditByOrder.get(order.id) ?? 0,
      unattributedCreditAmount: unattributedCreditByOrder.get(order.id) ?? 0,
      restoredCreditOutsideCreditNotes,
      pendingReturnAmount: pendingReturnTotal,
      orderTotal: orderGross,
    })
    // Con reversión ambigua el monto es sólo una cota: no se informa.
    if (orderReversal.ambiguous) web.ambiguousReversalOrders += 1
    else web.pendingReturnAdjustment += orderReversal.amount - reversal.amount
    for (const { line, financials } of orderLines) {
      sales.push({
        ...line,
        ...buildSaleFinancials({ ...financials, reversalAmbiguous: orderReversal.ambiguous }),
      })
    }

    // Lo revertido que no corresponde a un ítem puntual (NC general o de
    // envío, reintegro sin NC todavía, reintegro manual) va en una partida de
    // ajuste del pedido: así facturación comercial y resumen concilian.
    const orderAdjustment = orderReversal.amount - itemReversalApplied
    if (orderAdjustment > 0.005) {
      sales.push({
        id: `web-adjustment-${order.id}`,
        date,
        channel: "BEYONIX Web",
        kind: "adjustment",
        paymentMethod: getPaymentMethodLabel(order),
        productName: `Ajuste pedido #${order.id}`,
        categoryName: null,
        sku: null,
        quantity: 0,
        orderId: String(order.id),
        ...buildSaleFinancials({
          grossSales: 0,
          reversalAmount: orderAdjustment,
          reversalAmbiguous: orderReversal.ambiguous,
          costableUnits: 0,
          costAmount: 0,
          costSource: "none",
        }),
      })
    }
  }

  // ---- Mercado Libre -------------------------------------------------
  const reviewsBySale = new Map<string, MercadoLibrePhysicalReview | null>()
  for (const review of input.marketplaceReturnReviews) {
    if (!review.mercadolibre_sale_id) continue
    reviewsBySale.set(String(review.mercadolibre_sale_id), toMercadoLibrePhysicalReview(review))
  }
  const marketplace = { fees: 0, shipping: 0, refunds: 0 }

  for (const row of input.marketplaceRows) {
    // Una sola resolución por venta (la misma que la pantalla ML): costo y
    // cantidad visible salen de este valor.
    const costableUnits = getMercadoLibreCostableUnits(row, reviewsBySale.get(String(row.id)) ?? null)
    const mapping = getMercadoLibreCostMapping(row)
    const saleDate = String(row.sale_date ?? row.imported_at ?? "")
    const dynamicUnitCost =
      mapping && saleDate
        ? mapping.standalone_key
          ? getStandaloneHistoricalUnitCost(input.productCosts, mapping.standalone_key, saleDate)
          : mapping.product_id
            ? getHistoricalUnitCost(costLedgers, mapping.product_id, mapping.variant_id, saleDate)
            : null
        : null
    const { unitCost, source } = reportedCost(row.costo_unitario_historico, dynamicUnitCost)
    const gross = amount(row.gross_amount)
    const refunds = Math.min(Math.max(gross, 0), getMercadoLibreRefundAmount(row))
    const fee = amount(row.fee_amount)
    const shipping = amount(row.shipping_amount)
    marketplace.fees += fee
    marketplace.shipping += shipping
    marketplace.refunds += refunds

    sales.push({
      id: `ml-${String(row.id)}`,
      date: saleDate || new Date().toISOString(),
      channel: "MercadoLibre Marketplace",
      kind: "sale",
      paymentMethod: "MercadoLibre",
      productName: String(row.product_name ?? "Venta MercadoLibre"),
      categoryName: null,
      sku: row.sku ? String(row.sku) : null,
      quantity: costableUnits,
      orderId: row.order_id ? String(row.order_id) : null,
      ...buildSaleFinancials({
        grossSales: gross,
        reversalAmount: refunds,
        feeAmount: fee,
        shippingCost: shipping,
        // net_amount = Total liquidado por ML (incluye ingresos por envío,
        // bonificaciones y demás conceptos del reporte): fuente única del neto.
        reportedNetAmount: row.net_amount as number | null | undefined,
        costableUnits,
        ...lineCost(unitCost, source, costableUnits),
      }),
    })
  }

  // ---- Ventas externas -----------------------------------------------
  const external = { damagedReturnReversals: 0, inconsistentProfitSales: 0 }

  for (const row of input.externalRows) {
    // Anulada, cargada por error, tanda deshecha o devolución vendible: la
    // venta no existió económicamente (la mercadería volvió). Una devolución
    // dañada sí: el ingreso se revierte pero la mercadería se perdió.
    const damagedReturn =
      row.status === "reversed" &&
      row.reversal_kind === "return" &&
      row.return_condition === "damaged"
    if (row.status === "reversed" && !damagedReturn) continue

    const quantity = Math.max(amount(row.quantity), 0)
    const saleDate = String(row.sale_date ?? "")
    const productId = positiveId(row.product_id)
    const variantId = positiveId(row.variant_id)
    // Costo contra el libro de compras en la fecha real de la venta, igual
    // que web y ML; el valor cargado a mano sólo sin producto catalogado.
    const dynamicUnitCost =
      productId && saleDate
        ? getHistoricalUnitCost(costLedgers, productId, variantId, saleDate)
        : null
    const historical = reportedCost(row.costo_unitario_historico, dynamicUnitCost)
    const unitCost = resolveExternalSaleUnitCost({
      productId,
      historicalUnitCost: historical.unitCost,
      manualUnitCost: row.unit_cost,
    })
    // Ventas históricas importadas: la ganancia declarada en el Excel manda
    // (ver resolveExternalSaleReportedProfitability) y su costo es inferido.
    const profitability = resolveExternalSaleReportedProfitability({
      stockEffect: row.stock_effect,
      declaredProfit: row.declared_profit,
      grossAmount: row.gross_amount,
      feeAmount: row.fee_amount,
      shippingAmount: row.shipping_amount,
      otherExpenseAmount: row.other_expense_amount,
      merchandiseCost: getExternalSaleMerchandiseCost(unitCost, quantity),
    })
    if (profitability.costStatus === "inconsistent") external.inconsistentProfitSales += 1
    const costSource: SaleCostSource =
      profitability.merchandiseCost == null
        ? "missing"
        : profitability.profitSource === "declared"
          ? "inferred"
          : productId
            ? historical.source
            : "manual"
    const gross = amount(row.gross_amount)
    if (damagedReturn) external.damagedReturnReversals += gross

    sales.push({
      id: `external-${String(row.id)}`,
      date: saleDate || new Date().toISOString(),
      channel: "Ventas externas",
      kind: "sale",
      paymentMethod: String(row.payment_method ?? "Venta externa"),
      productName: String(row.product_name ?? "Venta externa"),
      categoryName: null,
      sku: row.sku ? String(row.sku) : null,
      quantity: damagedReturn ? 0 : quantity,
      orderId: row.reference ? String(row.reference) : null,
      ...buildSaleFinancials({
        grossSales: gross,
        reversalAmount: damagedReturn ? gross : 0,
        // shipping_amount = logística absorbida por BEYONIX. En una devolución
        // dañada comisiones, envío y otros gastos ya se pagaron: no vuelven.
        feeAmount: amount(row.fee_amount),
        shippingCost: amount(row.shipping_amount),
        otherCosts: amount(row.other_expense_amount),
        costableUnits: quantity,
        costAmount: profitability.merchandiseCost,
        costSource,
        declaredProfit: damagedReturn ? null : profitability.profitAmount,
      }),
    })
  }

  // ---- Gastos e inventario -------------------------------------------
  // Sólo mercadería incorporada al inventario (recibida o su parte recibida).
  const inventoryPurchases = input.productCosts.reduce((total, row) => {
    const contribution = getReceivedCostContribution(row)
    return contribution ? total + contribution.cost : total
  }, 0)

  const expenses = {
    paid: 0,
    pending: 0,
    productEconomicCost: 0,
    costableUnits: 0,
    coveredUnits: 0,
    paidByDate: [] as PaidExpenseDay[],
  }
  const paidByDate = new Map<string, PaidExpenseDay>()
  const addPaid = (date: string, value: number, costMissing = false) => {
    if (!value && !costMissing) return
    const day = paidByDate.get(date) ?? { date, amount: 0, costMissing: false }
    day.amount += value
    day.costMissing ||= costMissing
    paidByDate.set(date, day)
  }
  for (const row of input.expenses) {
    if (row.status === "pagado") {
      expenses.paid += amount(row.amount)
      addPaid(row.expense_date, amount(row.amount))
    } else if (row.status === "pendiente") {
      expenses.pending += amount(row.amount)
    }
    // Donación/sorteo: amount es 0 por esquema, pero la mercadería tiene
    // costo económico real con el mismo costo histórico que una venta.
    if (row.expense_type === "product" && row.product_id) {
      const quantity = Math.max(0, amount(row.quantity))
      const unitCost = getHistoricalUnitCost(costLedgers, row.product_id, row.variant_id, row.expense_date)
      expenses.costableUnits += quantity
      if (unitCost != null) expenses.coveredUnits += quantity
      const economicCost = getProductExpenseEconomicCost(row.quantity, unitCost)
      expenses.productEconomicCost += economicCost
      addPaid(row.expense_date, economicCost, quantity > 0 && unitCost == null)
    }
  }
  expenses.paid += expenses.productEconomicCost
  expenses.paidByDate = Array.from(paidByDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))

  const totals = summarizeSaleFinancials(sales)

  return {
    sales,
    totals,
    channels: {
      web: summarizeSaleFinancials(sales.filter((sale) => sale.channel === "BEYONIX Web")),
      marketplace: summarizeSaleFinancials(sales.filter((sale) => sale.channel === "MercadoLibre Marketplace")),
      external: summarizeSaleFinancials(sales.filter((sale) => sale.channel === "Ventas externas")),
    },
    web,
    marketplace,
    external,
    expenses,
    inventoryPurchases,
    costCoveragePercent: getCoveragePercent(
      totals.confirmedCostUnits + totals.inferredCostUnits + expenses.coveredUnits,
      totals.costableUnits + expenses.costableUnits,
    ),
  }
}
