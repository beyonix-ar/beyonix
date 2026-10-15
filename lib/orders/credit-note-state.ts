/**
 * Estado ÚNICO de la Nota de Crédito C de un pedido. Toda vista (progreso,
 * Cancelación, Facturación, campana, pendientes, Cliente) lo deriva de acá:
 * así no puede mostrarse "NC emitida" y "Emitir NC" a la vez.
 *
 * Pura y sincrónica: sólo lee columnas del pedido y, si vienen, sus NC.
 */

import { getLegacyCreditNoteState, type LegacyCreditNoteOrder } from "./legacy-credit-note.ts"

export type CreditNoteState =
  /** No hay factura o la venta no requiere NC. */
  | "not_required"
  /** Factura emitida sobre una venta cancelada: falta emitir la NC. */
  | "required"
  /** Caso heredado: el dinero ya volvió y falta la NC sólo fiscal. */
  | "legacy_required"
  /** En ARCA (esperando CAE). */
  | "processing"
  /** ARCA rechazó o falló, sin otra NC autorizada que la cubra. */
  | "error"
  /** NC autorizada por menos que lo facturado. */
  | "authorized_partial"
  /** NC autorizada por todo lo facturado; su dinero todavía no se liquidó. */
  | "settlement_pending"
  /** NC autorizada por todo lo facturado y liquidada (o sin dinero que mover). */
  | "settled"

export interface CreditNoteStateNote {
  status?: string | null
  destination?: string | null
  settlement_status?: string | null
  total_amount?: number | string | null
}

export interface CreditNoteStateOrder extends LegacyCreditNoteOrder {
  total?: number | string | null
  credit_note_status?: string | null
  credit_note_amount?: number | string | null
  order_credit_notes?: Array<CreditNoteStateNote> | null
}

export interface CreditNoteStateView {
  state: CreditNoteState
  label: string
  /** Hay algo que el Admin tiene que hacer con la NC. */
  requiresAction: boolean
  /** Hay al menos una NC autorizada. */
  authorized: boolean
  /** Única acción fiscal ofrecida para emitir (nunca dos a la vez). */
  emitAction: "standard" | "legacy" | null
}

export const CREDIT_NOTE_STATE_LABELS: Record<CreditNoteState, string> = {
  not_required: "No requerida",
  required: "Pendiente de emisión",
  legacy_required: "Pendiente (caso heredado)",
  processing: "En proceso en ARCA",
  error: "Con error: requiere revisión",
  authorized_partial: "Emitida (parcial)",
  settlement_pending: "Emitida · liquidación pendiente",
  settled: "Emitida y liquidada",
}

const cents = (value: number | string | null | undefined) => Math.round(Number(value ?? 0) * 100)

export function getCreditNoteState(order: CreditNoteStateOrder): CreditNoteStateView {
  const view = (state: CreditNoteState, emitAction: CreditNoteStateView["emitAction"] = null): CreditNoteStateView => ({
    state,
    label: CREDIT_NOTE_STATE_LABELS[state],
    requiresAction: ["required", "legacy_required", "error"].includes(state),
    authorized: ["authorized_partial", "settlement_pending", "settled"].includes(state),
    emitAction,
  })

  const notes = order.order_credit_notes
  // Sin el detalle de NC (p. ej. vista del Cliente) se usa el resumen del pedido.
  if (!notes) {
    if (order.credit_note_status === "authorized") {
      return view(cents(order.credit_note_amount) >= cents(order.total) && cents(order.total) > 0 ? "settled" : "authorized_partial")
    }
    if (order.credit_note_status === "processing") return view("processing")
    if (order.credit_note_status === "error") return view("error")
    const legacy = getLegacyCreditNoteState(order)
    if (legacy === "pending") return view("legacy_required", "legacy")
    if (legacy === "processing") return view("processing")
    return order.credit_note_required ? view("required", "standard") : view("not_required")
  }

  const authorized = notes.filter((note) => note.status === "authorized")
  if (notes.some((note) => note.status === "processing")) return view("processing")

  const legacy = getLegacyCreditNoteState(order)
  if (legacy === "pending") return view("legacy_required", "legacy")

  if (authorized.length) {
    const authorizedCents = authorized.reduce((sum, note) => sum + cents(note.total_amount), 0)
    if (cents(order.total) > 0 && authorizedCents < cents(order.total)) return view("authorized_partial")
    const unsettled = authorized.some((note) => note.destination !== "none" && note.settlement_status !== "completado")
    return view(unsettled ? "settlement_pending" : "settled")
  }
  if (notes.some((note) => note.status === "error")) return view("error")
  return order.credit_note_required ? view("required", "standard") : view("not_required")
}
