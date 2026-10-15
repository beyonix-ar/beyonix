/**
 * NC de casos heredados: pedidos cancelados y ya reintegrados ANTES de que
 * rigiera "primero factura, después reintegro" (20261014110000). La factura
 * salió después del reintegro y la NC obligatoria quedó sin camino: el
 * circuito automático sólo toma pedidos con reintegro pendiente y la NC
 * habitual rechaza mover dinero de un pedido reintegrado.
 *
 * La NC heredada es sólo fiscal (destino "none"): anula la factura sin
 * acreditar saldo ni disparar otro reintegro, porque el dinero ya volvió.
 */

import { roundCreditMoney, type CreditNoteItemAllocation } from "./credit-note-calculations.ts"

export interface LegacyCreditNoteOrder {
  estado?: string | null
  financial_status?: string | null
  credit_note_required?: boolean | null
  invoice_status?: string | null
  invoice_cae?: string | null
  invoice_number?: number | string | null
  invoice_point?: number | string | null
  refunded_at?: string | null
  order_credit_notes?: Array<{ status?: string | null }> | null
}

export type LegacyCreditNoteState = "none" | "pending" | "processing"

export function getLegacyCreditNoteState(order: LegacyCreditNoteOrder): LegacyCreditNoteState {
  const isLegacyCase =
    order.estado === "cancelado" &&
    order.financial_status === "refunded" &&
    order.credit_note_required === true &&
    Boolean(order.refunded_at) &&
    order.invoice_status === "authorized" &&
    Boolean(order.invoice_cae) &&
    Boolean(order.invoice_number) &&
    Boolean(order.invoice_point)
  if (!isLegacyCase) return "none"

  const notes = order.order_credit_notes ?? []
  if (notes.some((note) => note.status === "authorized")) return "none"
  if (notes.some((note) => note.status === "processing")) return "processing"
  return "pending"
}

/**
 * Importes de una NC que anula la factura completa: los artículos a su valor
 * efectivo y el resto (envío cobrado, redondeos) como ajuste, de modo que la
 * NC coincida exactamente con el total facturado.
 */
export function buildLegacyCreditNoteAmounts(invoiceTotal: number, effectiveItemAmounts: number[]) {
  const total = roundCreditMoney(invoiceTotal)
  const itemsAmount = roundCreditMoney(effectiveItemAmounts.reduce((sum, amount) => sum + amount, 0))
  const manualAmount = roundCreditMoney(total - itemsAmount)
  if (!Number.isFinite(total) || !Number.isFinite(itemsAmount) || !Number.isFinite(manualAmount) || total <= 0 || manualAmount < 0) return null
  return { itemsAmount, manualAmount, totalAmount: total }
}

type LegacyOrderItem = {
  id: number
  producto_id: number | null
  variante_id: number | null
  conditioned_name: string | null
  cantidad: number
  precio: number
}

type LegacyInvoiceItemSnapshot = {
  order_item_id: number
  product_name: string | null
  variant_name: string | null
}

const placeholderName = /^(?:Producto(?: #\d+| eliminado)?|Artículo(?: #\d+)?|Sin nombre)$/i

function realName(value: string | null | undefined) {
  const name = value?.trim()
  return name && !placeholderName.test(name) ? name : null
}

/** Valida todo el detalle obligatorio antes de crear una reserva fiscal. */
export function buildLegacyCreditNoteItems(
  items: LegacyOrderItem[],
  allocations: CreditNoteItemAllocation[],
  snapshots: LegacyInvoiceItemSnapshot[],
  productNames: Map<number, string>,
  variantNames: Map<number, string>,
):
  | { items: Array<{ order_item_id: number; quantity: number; unit_amount: number; total_amount: number; product_name: string; variant_name: string | null }>; error?: never }
  | { items?: never; error: { code: "ITEM_DATA_INVALID" | "ITEM_NAME_MISSING"; orderItemId: number } } {
  const allocationsById = new Map(allocations.map((allocation) => [allocation.orderItemId, allocation]))
  const snapshotsById = new Map(snapshots.map((snapshot) => [Number(snapshot.order_item_id), snapshot]))
  if (allocations.length !== items.length || allocationsById.size !== items.length) {
    const missing = items.find((item) => !allocationsById.has(Number(item.id)))
    return { error: { code: "ITEM_DATA_INVALID", orderItemId: Number(missing?.id ?? items[0]?.id ?? 0) } }
  }

  const creditItems = [] as Array<{ order_item_id: number; quantity: number; unit_amount: number; total_amount: number; product_name: string; variant_name: string | null }>
  for (const item of items) {
    const id = Number(item.id)
    const allocation = allocationsById.get(id)
    if (
      !Number.isSafeInteger(id) || id <= 0 || !allocation ||
      item.cantidad == null || item.precio == null ||
      !Number.isInteger(Number(item.cantidad)) || Number(item.cantidad) !== allocation.soldQuantity ||
      !Number.isInteger(allocation.soldQuantity) || allocation.soldQuantity <= 0 || allocation.soldQuantity > 2147483647 ||
      !Number.isFinite(Number(item.precio)) || Number(item.precio) < 0 ||
      !Number.isFinite(allocation.effectiveUnitAmount) || allocation.effectiveUnitAmount < 0 || allocation.effectiveUnitAmount >= 100000000 ||
      !Number.isFinite(allocation.effectiveLineAmount) || allocation.effectiveLineAmount < 0 || allocation.effectiveLineAmount >= 10000000000
    ) return { error: { code: "ITEM_DATA_INVALID", orderItemId: id } }

    const snapshot = snapshotsById.get(id)
    const productName = realName(snapshot?.product_name) ?? realName(productNames.get(Number(item.producto_id))) ??
      realName(item.conditioned_name)
    if (!productName) return { error: { code: "ITEM_NAME_MISSING", orderItemId: id } }
    const variantName = realName(snapshot?.variant_name) ?? realName(item.conditioned_name) ??
      realName(variantNames.get(Number(item.variante_id)))
    creditItems.push({
      order_item_id: id,
      quantity: allocation.soldQuantity,
      unit_amount: allocation.effectiveUnitAmount,
      total_amount: allocation.effectiveLineAmount,
      product_name: productName.slice(0, 240),
      variant_name: variantName && variantName !== productName ? variantName.slice(0, 240) : null,
    })
  }
  return { items: creditItems }
}

export const LEGACY_CREDIT_NOTE_REASON =
  "Nota de crédito de caso heredado: pedido cancelado y reintegrado antes de emitirse la factura."
