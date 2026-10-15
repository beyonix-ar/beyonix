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
import { getCreditNoteObligation } from "./credit-note-obligation.ts"

export interface LegacyCreditNoteOrder {
  total?: number | string | null
  estado?: string | null
  financial_status?: string | null
  credit_note_required?: boolean | null
  invoice_status?: string | null
  invoice_cae?: string | null
  invoice_number?: number | string | null
  invoice_point?: number | string | null
  refunded_at?: string | null
  order_credit_notes?: Array<{ status?: string | null; total_amount?: number | string | null }> | null
}

/**
 * pending: no existe ninguna NC autorizada → se ofrece emitirla.
 * manual_review: hay NC autorizadas por menos del total facturado → nunca se
 * ofrece otra emisión automática (evita duplicar importe fiscal).
 */
export type LegacyCreditNoteState = "none" | "pending" | "processing" | "manual_review"

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

  switch (getCreditNoteObligation(order).status) {
    case "processing":
      return "processing"
    case "missing":
      return "pending"
    case "insufficient":
      return "manual_review"
    default:
      return "none"
  }
}

export const LEGACY_CREDIT_NOTE_REJECTED_ACTION = "legacy_credit_note_rejected"

/**
 * Último intento de emisión rechazado ANTES de reservar la NC (configuración,
 * ambiente, reserva). Sólo se informa si es posterior a cualquier intento
 * reservado: un pedido que luego avanzó no muestra un rechazo viejo.
 */
export function getLastLegacyCreditNoteRejection(
  events: ReadonlyArray<{ action?: string | null; created_at?: string | null; metadata?: unknown }> | null | undefined,
): { at: string | null; message: string } | null {
  let latest: { at: string | null; message: string } | null = null
  for (const event of events ?? []) {
    if (event.action === "legacy_credit_note_requested") latest = null
    if (event.action !== LEGACY_CREDIT_NOTE_REJECTED_ACTION) continue
    const metadata = event.metadata && typeof event.metadata === "object" ? (event.metadata as Record<string, unknown>) : {}
    latest = {
      at: event.created_at ?? null,
      message: typeof metadata.message === "string" && metadata.message ? metadata.message : "Motivo no registrado.",
    }
  }
  return latest
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
