import { getCancellationNextAction, type CancellationNextActionOrder } from "../orders/cancellation-next-action.ts"
import { getCreditNoteState, type CreditNoteStateOrder } from "../orders/credit-note-state.ts"

export interface OperationalStep { label: string; complete: boolean }

export function getCancellationProgress(order: CancellationNextActionOrder & CreditNoteStateOrder): OperationalStep[] {
  const next = getCancellationNextAction(order)
  if (next.state === "none") return []
  const completed = next.state === "completed"
  const steps: OperationalStep[] = []
  if (next.reason === "pending_payment_review") steps.push({ label: "Revisar el pago", complete: false })
  if (next.reason === "invoice_missing") steps.push({ label: "Autorizar factura", complete: false })
  if (order.credit_note_required || order.invoice_cae || order.order_credit_notes?.length || ["emit_credit_note", "wait_credit_note"].includes(next.state)) {
    // Reintegrado no implica NC emitida: un caso heredado (reintegro anterior
    // a la factura) sigue con la NC obligatoria pendiente.
    const creditNote = getCreditNoteState(order)
    steps.push({ label: "Nota de crédito", complete: creditNote.authorized || (completed && creditNote.state === "not_required") })
  }
  steps.push({ label: next.state === "reconcile_mp_refund" ? "Comprobar el reintegro" : "Reintegro", complete: completed })
  return steps
}

export function getReceptionProgress(sold: number, claimed: number, received: number) {
  return { sold, claimed, received, remaining: Math.max(0, claimed - received) }
}
