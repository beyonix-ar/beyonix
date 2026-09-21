import { getCancellationNextAction, type CancellationNextActionOrder } from "../orders/cancellation-next-action.ts"

export interface OperationalStep { label: string; complete: boolean }

export function getCancellationProgress(order: CancellationNextActionOrder): OperationalStep[] {
  const next = getCancellationNextAction(order)
  if (next.state === "none") return []
  const completed = next.state === "completed"
  const steps: OperationalStep[] = []
  if (next.reason === "pending_payment_review") steps.push({ label: "Revisar el pago", complete: false })
  if (next.reason === "invoice_missing") steps.push({ label: "Autorizar factura", complete: false })
  if (order.credit_note_required || order.invoice_cae || order.order_credit_notes?.length || ["emit_credit_note", "wait_credit_note"].includes(next.state)) {
    steps.push({ label: "Nota de crédito", complete: completed || Boolean(order.order_credit_notes?.some((note) => note.status === "authorized")) })
  }
  steps.push({ label: next.state === "reconcile_mp_refund" ? "Comprobar el reintegro" : "Reintegro", complete: completed })
  return steps
}

export function getReceptionProgress(sold: number, claimed: number, received: number) {
  return { sold, claimed, received, remaining: Math.max(0, claimed - received) }
}
