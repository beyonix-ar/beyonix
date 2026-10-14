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

import { roundCreditMoney } from "./credit-note-calculations.ts"

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
  if (total <= 0 || manualAmount < 0) return null
  return { itemsAmount, manualAmount, totalAmount: total }
}

export const LEGACY_CREDIT_NOTE_REASON =
  "Nota de crédito de caso heredado: pedido cancelado y reintegrado antes de emitirse la factura."
