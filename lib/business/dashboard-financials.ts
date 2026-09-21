/**
 * Auditoría 5/7 (dashboard/reportes), Fases 1-2: fórmulas financieras del
 * dashboard extraídas de app/api/admin/dashboard/route.ts como funciones
 * puras testeables -- ese endpoint es demasiado grande para tener cobertura
 * real sin aislar la lógica de agregación de las llamadas a Supabase.
 */

export interface MercadoPagoPaymentSnapshot {
  transaction_amount?: number | null
  fee_details?: Array<{ type?: string | null; amount?: number | null }> | null
  transaction_details?: {
    net_received_amount?: number | null
    total_paid_amount?: number | null
  } | null
}

function financialAmount(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

/**
 * Comisión real de Mercado Pago para un pago aprobado, a partir del snapshot
 * persistido por el webhook (nunca del % configurado). Preferí
 * transaction_amount - net_received_amount (lo efectivamente no recibido,
 * incluye comisión + costo financiero) porque es el dato más directo; si
 * net_received_amount no está disponible, cae a la suma de fee_details.
 * P0 confirmado en Auditoría 5/7: este dato existía desde el webhook pero
 * nunca se leía ni se restaba en ningún lado del dashboard.
 */
export function getMercadoPagoFeeAmount(
  snapshot: MercadoPagoPaymentSnapshot | null | undefined,
): number {
  if (!snapshot) return 0

  const transactionAmount = financialAmount(snapshot.transaction_amount)
  const netReceived = snapshot.transaction_details?.net_received_amount

  if (
    transactionAmount > 0 &&
    netReceived != null &&
    Number.isFinite(Number(netReceived))
  ) {
    return Math.max(0, transactionAmount - Number(netReceived))
  }

  const feeDetails = snapshot.fee_details ?? []
  return feeDetails.reduce(
    (total, fee) => total + Math.abs(Number(fee?.amount ?? 0)),
    0,
  )
}

export function calculateMercadoPagoFees(
  snapshots: Array<MercadoPagoPaymentSnapshot | null | undefined>,
): number {
  return snapshots.reduce(
    (total, snapshot) => total + getMercadoPagoFeeAmount(snapshot),
    0,
  )
}

export type OrderRevenueReversalStatus = "none" | "pending" | "completed"

export interface OrderRevenueReversal {
  status: OrderRevenueReversalStatus
  amount: number
}

export interface RevenueReversalOrder {
  financial_status?: string | null
  refunded_at?: string | null
  invoice_status?: string | null
  refund_amount?: number | string | null
  total?: number | string | null
  original_total?: number | string | null
  credit_balance_used?: number | string | null
  customer_credit_restored_amount?: number | string | null
}

function getNonInvoicedReversalAmount(order: RevenueReversalOrder) {
  const orderTotal = financialAmount(order.original_total ?? order.total)
  if (order.refund_amount == null) return orderTotal

  const monetaryRefund = financialAmount(order.refund_amount)
  const restoredCredit = financialAmount(order.customer_credit_restored_amount)
  return orderTotal > 0
    ? Math.min(orderTotal, monetaryRefund + restoredCredit)
    : monetaryRefund + restoredCredit
}

/**
 * Fuente única de "cuánto de esta orden dejó de ser ingreso real", para
 * evitar los dos mecanismos que existían antes (webCompletedRefunds +
 * pendingRefunds) descontando la misma plata por caminos distintos. Un solo
 * status por orden, ramas mutuamente excluyentes:
 *  - "completed": ya hay una NC autorizada (banco o saldo, misma fuente que
 *    antes) o la orden quedó refunded sin factura -- se descuenta íntegro.
 *  - "pending": financial_status=refund_pending sin NC autorizada todavía
 *    (P0 confirmado en Auditoría 5/7: esta ventana normal de operación no
 *    descontaba nada de netSales/trueProfit, así que una orden cancelada con
 *    reintegro pendiente contaba como venta íntegra).
 *  - "none": ninguna reversión en curso.
 * No se muta payment_status (instrucción explícita): la clasificación se
 * arma sólo a partir de financial_status/invoice_status/refund_amount.
 */
export function getOrderRevenueReversal(
  order: RevenueReversalOrder,
  authorizedCreditAmount: number,
): OrderRevenueReversal {
  const authorizedAmount = financialAmount(authorizedCreditAmount)
  if (authorizedAmount > 0) {
    const orderTotal = financialAmount(order.original_total ?? order.total)
    const completedAmount =
      authorizedAmount + financialAmount(order.customer_credit_restored_amount)
    return {
      status: "completed",
      amount: orderTotal > 0 ? Math.min(orderTotal, completedAmount) : completedAmount,
    }
  }

  const nonInvoicedRefunded =
    order.invoice_status !== "authorized" &&
    (order.financial_status === "refunded" || Boolean(order.refunded_at))
  if (nonInvoicedRefunded) {
    return {
      status: "completed",
      amount: getNonInvoicedReversalAmount(order),
    }
  }

  if (order.financial_status === "refund_pending") {
    return {
      status: "pending",
      amount: getNonInvoicedReversalAmount(order),
    }
  }

  return { status: "none", amount: 0 }
}

/**
 * Ventas netas del canal web: bruto menos toda reversión de ingreso
 * (completada o pendiente, fuente única de arriba). Los descuentos por
 * transferencia ya están incorporados en original_total al crear la orden,
 * por lo que restarlos otra vez duplicaría el descuento. La comisión de MP
 * es un costo separado de trueProfit y no modifica el ingreso de la venta.
 */
export function calculateWebNetSales(input: {
  grossSales: number
  revenueReversed: number
}): number {
  return input.grossSales - input.revenueReversed
}

export function calculateMarketplaceNet(input: {
  grossSales: number
  fees: number
  shipping: number
  refunds: number
}): number {
  return (
    input.grossSales - input.fees - input.shipping - input.refunds
  )
}

export function calculatePendingRefundAdjustment(input: {
  unitPrice: number
  receivedQuantity: number
  creditedQuantity: number
  orderReversalStatus: OrderRevenueReversalStatus
}): number {
  if (input.orderReversalStatus !== "none") return 0

  const received = financialAmount(input.receivedQuantity)
  const credited = Math.min(received, financialAmount(input.creditedQuantity))
  return financialAmount(input.unitPrice) * Math.max(0, received - credited)
}

export function calculateTrueProfit(input: {
  netSales: number
  webShippingCost: number
  costOfGoodsSold: number
  operatingExpenses: number
  pendingReturnAdjustment: number
  mercadoPagoFees: number
}): number {
  return (
    input.netSales -
    input.webShippingCost -
    input.costOfGoodsSold -
    input.operatingExpenses -
    input.pendingReturnAdjustment -
    input.mercadoPagoFees
  )
}

/**
 * Costo económico real de un gasto tipo "producto" (donación/sorteo): el
 * campo amount de business_expenses queda forzado a 0 por el esquema (la
 * salida de caja real ES 0), pero eso no significa que el costo de la
 * mercadería sea $0 -- se calcula con el mismo costo histórico usado para
 * COGS en cualquier otro canal, y se agrega a los gastos operativos, nunca
 * al importe cobrado. p_unitCost null significa "todavía no hay compras
 * cargadas para costear esto" (igual semántica que el resto del dashboard):
 * en ese caso no se puede afirmar el costo, se devuelve 0 en vez de inventar
 * un número.
 */
export function getProductExpenseEconomicCost(
  quantity: number | null | undefined,
  unitCost: number | null,
): number {
  if (unitCost == null) return 0
  const safeQuantity = Math.max(0, Number(quantity ?? 0))
  return safeQuantity * unitCost
}
