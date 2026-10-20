/**
 * Historial de gestión de Facturación (devoluciones, reintegros, notas de
 * crédito, saldo) en lenguaje de operador: nunca el código interno del
 * evento ni su metadata cruda.
 */

export interface OrderManagementEventSource {
  action: string
  metadata?: Record<string, unknown> | null
}

export interface OrderManagementEventView {
  title: string
  /** Datos legibles del evento (vacío si no hay nada útil que mostrar). */
  facts: string[]
}

const MANAGEMENT_TOKENS = ["credit_note", "refund", "return", "cancel", "customer_balance"]

export function isOrderManagementEvent(action: string) {
  return MANAGEMENT_TOKENS.some((token) => action.includes(token))
}

const DESTINATION_LABELS: Record<string, string> = {
  customer_balance: "saldo a favor del cliente",
  external_refund: "reintegro externo",
  mercadopago_refund: "devolución por Mercado Pago",
}

const AMOUNT_KEYS = ["amount", "totalAmount", "total_amount", "creditAmount", "refundAmount"]
const REASON_KEYS = ["reason", "notes", "note"]

function count(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null
}

const units = (quantity: number) => (quantity === 1 ? "1 unidad" : `${quantity} unidades`)

export function getOrderManagementEventTitle(action: string) {
  if (action === "return_inventory_processed") return "Inventario actualizado"
  if (action.includes("settlement")) return "Saldo acreditado"
  if (action.includes("credit_note_authorized")) return "Nota de crédito autorizada"
  if (action.includes("refund_proof")) return "Comprobante de reintegro cargado"
  if (action.includes("refunded")) return "Reintegro completado"
  if (action.includes("return")) return "Devolución actualizada"
  if (action.includes("cancel")) return "Cancelación actualizada"
  return "Gestión actualizada"
}

export function describeOrderManagementEvent(
  event: OrderManagementEventSource,
  options: { itemName?: (orderItemId: number) => string | null; formatAmount: (amount: number) => string },
): OrderManagementEventView {
  const metadata = event.metadata ?? {}
  const facts: string[] = []

  if (event.action === "return_inventory_processed") {
    const orderItemId = count(metadata.orderItemId)
    const name = orderItemId !== null ? options.itemName?.(orderItemId) : null
    if (name) facts.push(`Producto: ${name}`)
    const sellable = count(metadata.sellableQuantity) ?? 0
    const discounted = count(metadata.discountedQuantity) ?? 0
    const nonSellable = count(metadata.nonSellableQuantity) ?? 0
    facts.push(`${units(sellable + discounted + nonSellable)} ${sellable + discounted + nonSellable === 1 ? "procesada" : "procesadas"}`)
    facts.push(`Reingreso vendible: ${sellable}`)
    if (discounted > 0) facts.push(`Reingreso con descuento: ${discounted}`)
    facts.push(`No vendible: ${nonSellable}`)
    const remaining = count(metadata.remaining)
    if (remaining !== null) facts.push(`Restante por procesar: ${remaining}`)
    return { title: getOrderManagementEventTitle(event.action), facts }
  }

  const amountKey = AMOUNT_KEYS.find((key) => Number.isFinite(Number(metadata[key])) && metadata[key] !== null && metadata[key] !== "")
  if (amountKey) facts.push(`Importe: ${options.formatAmount(Number(metadata[amountKey]))}`)
  const destination = typeof metadata.destination === "string" ? DESTINATION_LABELS[metadata.destination] : undefined
  if (destination) facts.push(`Destino: ${destination}`)
  const reasonKey = REASON_KEYS.find((key) => typeof metadata[key] === "string" && String(metadata[key]).trim())
  if (reasonKey) {
    const reason = String(metadata[reasonKey]).trim()
    facts.push(`Motivo: ${reason.length > 200 ? `${reason.slice(0, 199)}…` : reason}`)
  }
  return { title: getOrderManagementEventTitle(event.action), facts }
}
