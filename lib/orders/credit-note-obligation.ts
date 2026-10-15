/**
 * Única fuente de verdad de "¿esta factura necesita (todavía) una nota de
 * crédito?". La usan el progreso operativo, el panel de cancelación, el
 * panel de NC heredada, las acciones pendientes y la campana: así nunca se
 * muestra "NC completada" y "NC pendiente" a la vez.
 *
 * Regla fiscal: una NC sólo se considera cubierta cuando las notas
 * AUTORIZADAS suman el total facturado. Una NC autorizada por menos no cubre
 * la obligación, pero tampoco habilita emitir otra automáticamente: queda
 * para revisión manual (nunca se ofrece una segunda emisión por el mismo
 * importe fiscal).
 */

import { roundCreditMoney } from "./credit-note-calculations.ts"

export interface CreditNoteObligationOrder {
  total?: number | string | null
  credit_note_required?: boolean | null
  invoice_status?: string | null
  invoice_cae?: string | null
  order_credit_notes?: Array<{ status?: string | null; total_amount?: number | string | null }> | null
}

export type CreditNoteObligationStatus =
  /** Sin factura autorizada ni NC exigida. */
  | "not_required"
  /** NC autorizadas por el total facturado (o NC parcial sin obligación de anular el resto). */
  | "covered"
  /** Hay una NC comunicándose con ARCA. */
  | "processing"
  /** NC obligatoria y no existe ninguna autorizada. */
  | "missing"
  /** NC obligatoria con notas autorizadas por menos del total facturado. */
  | "insufficient"

export interface CreditNoteObligation {
  status: CreditNoteObligationStatus
  invoicedTotal: number
  authorizedTotal: number
  /** Importe fiscal que falta cubrir (0 salvo missing/insufficient). */
  missingAmount: number
}

const AMOUNT_TOLERANCE = 0.01

export function getCreditNoteObligation(order: CreditNoteObligationOrder): CreditNoteObligation {
  const notes = order.order_credit_notes ?? []
  const authorizedNotes = notes.filter((note) => note.status === "authorized")
  const invoicedTotal = roundCreditMoney(Number(order.total ?? 0))
  const authorizedTotal = roundCreditMoney(
    authorizedNotes.reduce((sum, note) => sum + Number(note.total_amount ?? 0), 0),
  )
  const result = (status: CreditNoteObligationStatus, missingAmount = 0): CreditNoteObligation => ({
    status,
    invoicedTotal,
    authorizedTotal,
    missingAmount: roundCreditMoney(Math.max(0, missingAmount)),
  })

  if (notes.some((note) => note.status === "processing")) return result("processing")

  const invoiced = order.invoice_status === "authorized" && Boolean(order.invoice_cae)
  if (order.credit_note_required !== true || !invoiced) {
    return result(authorizedNotes.length > 0 ? "covered" : "not_required")
  }

  if (authorizedNotes.length === 0) return result("missing", invoicedTotal)
  // Lectura sin importes: una NC autorizada de monto desconocido nunca habilita
  // otra emisión (se prioriza no duplicar comprobantes fiscales).
  if (authorizedNotes.some((note) => note.total_amount == null || note.total_amount === "")) return result("covered")
  if (authorizedTotal + AMOUNT_TOLERANCE >= invoicedTotal) return result("covered")
  return result("insufficient", invoicedTotal - authorizedTotal)
}

export function isCreditNoteObligationPending(obligation: CreditNoteObligation) {
  return obligation.status === "missing" || obligation.status === "insufficient"
}

export const CREDIT_NOTE_OBLIGATION_LABELS: Record<CreditNoteObligationStatus, string> = {
  not_required: "No corresponde nota de crédito",
  covered: "Nota de crédito emitida",
  processing: "Nota de crédito en proceso",
  missing: "Nota de crédito pendiente",
  insufficient: "Nota de crédito parcial: requiere revisión",
}
