/**
 * Asistente secuencial de una cancelación: Cancelación → Mercadería → Dinero
 * → Nota de crédito → Reintegro → Finalizado. Pura y derivada del estado
 * persistido (sin I/O): volver, recargar o abrir el pedido en otra pestaña
 * muestra siempre el mismo paso, porque el progreso vive en la base.
 *
 * No decide reglas nuevas: la mercadería sale de la retención física
 * (admin_pending_facts.dispatch), el dinero del orquestador financiero
 * (admin_pending_facts.financial) y de getCancellationNextAction, y la NC de
 * getCreditNoteState. Las acciones de dinero siguen en el panel de abajo.
 */

import { getCancellationNextAction, type CancellationNextActionOrder } from "./cancellation-next-action.ts"
import { getCreditNoteState, type CreditNoteStateOrder } from "./credit-note-state.ts"
import { hasPendingInvoiceObligation } from "./fiscal-sequencing.ts"
import type { AdminPendingFacts } from "./admin-pending-actions.ts"

export type CancellationJourneyStepKey = "cancellation" | "merchandise" | "money" | "credit_note" | "refund" | "finished"
export type CancellationJourneyStepStatus = "done" | "current" | "processing" | "waiting" | "not_required" | "attention"

export interface CancellationJourneyStep {
  key: CancellationJourneyStepKey
  label: string
  status: CancellationJourneyStepStatus
  detail: string
}

export interface CancellationJourneyAction {
  kind: "resolve_merchandise"
  label: string
  href: string
}

export interface CancellationJourney {
  steps: CancellationJourneyStep[]
  /** Primer paso que necesita a una persona (o null si todo terminó o espera algo automático). */
  current: CancellationJourneyStepKey | null
  /** Acción fuera del panel de dinero (sólo "Resolver mercadería" en Despachos). */
  action: CancellationJourneyAction | null
  finished: boolean
}

export type CancellationJourneyOrder = CancellationNextActionOrder & CreditNoteStateOrder & {
  id: number
  cancelled_at?: string | null
  cancellation_requested_at?: string | null
  refunded_at?: string | null
  andreani_handed_over_at?: string | null
  admin_pending_facts?: AdminPendingFacts | null
}

export const CANCELLATION_JOURNEY_LABELS: Record<CancellationJourneyStepKey, string> = {
  cancellation: "Cancelación",
  merchandise: "Mercadería",
  money: "Dinero",
  credit_note: "Nota de crédito",
  refund: "Reintegro",
  finished: "Finalizado",
}

const bundleName = (number: number) => `Bulto ${String(number).padStart(4, "0")}`

/** Mismo href que arma lib/admin/dispatch-location (sin importar código de Admin). */
const resolveHref = (orderId: number) =>
  `/admin/despachos?resolve=${orderId}&return=${encodeURIComponent(`/admin/pedidos/${orderId}?tab=cancelacion`)}`

const isCancellationOrder = (order: CancellationJourneyOrder) =>
  order.estado === "cancelado" ||
  ["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(order.financial_status ?? "")

export function getCancellationJourney(order: CancellationJourneyOrder): CancellationJourney | null {
  if (!isCancellationOrder(order)) return null
  const dispatch = order.admin_pending_facts?.dispatch ?? null
  const financial = order.admin_pending_facts?.financial ?? null
  const next = getCancellationNextAction(order)
  const creditNote = getCreditNoteState(order)
  const refunded = order.financial_status === "refunded"
  // Devolución posterior al despacho inspeccionada y con el dinero rechazado.
  const rejected = order.financial_status === "refund_rejected" || financial?.returnDecision === "rejected"
  const inspectionPending = Boolean(financial?.returnInspectionPending)
  const paymentReview = next.state === "blocked" && next.reason === "pending_payment_review"
  const moneyInvolved = refunded || rejected || (next.state !== "none" && !paymentReview)
  const steps: CancellationJourneyStep[] = []
  const push = (key: CancellationJourneyStepKey, status: CancellationJourneyStepStatus, detail: string) =>
    steps.push({ key, label: CANCELLATION_JOURNEY_LABELS[key], status, detail })

  // 1. Cancelación: siempre registrada si llegamos acá.
  push("cancellation", "done", order.financial_status === "cancellation_requested"
    ? "Cancelación solicitada: falta revisar el comprobante de pago."
    : "Pedido cancelado.")

  // 2. Mercadería: la retención física decide; sin pickeo el stock volvió solo.
  const holdActive = Boolean(dispatch?.physicalHold)
  let action: CancellationJourneyAction | null = null
  if (holdActive) {
    const inBundle = Boolean(dispatch?.batchId) && dispatch?.batchStatus !== "handed_over"
    push("merchandise", "current", inBundle
      ? `Está dentro del ${bundleName(dispatch?.batchNumber ?? dispatch?.batchId ?? 0)}: retiralo antes de entregarlo y devolvé la mercadería al stock.`
      : "Hay mercadería pickeada que tiene que volver al stock.")
    action = { kind: "resolve_merchandise", label: "Resolver mercadería", href: resolveHref(order.id) }
  } else if (dispatch?.manualRefundRequired) {
    push("merchandise", "done", "Mercadería devuelta al stock.")
  } else if (rejected || financial?.returnDecision === "approved") {
    push("merchandise", "done", "Devolución recibida e inspeccionada.")
  } else if (inspectionPending) {
    push("merchandise", "current", "Registrá cómo volvió la mercadería y decidí la devolución del dinero.")
  } else if (order.andreani_handed_over_at) {
    push("merchandise", "attention", "El pedido ya se entregó al transportista: la mercadería vuelve con la devolución.")
  } else {
    push("merchandise", "done", "No había mercadería preparada: el stock volvió automáticamente.")
  }

  // 3. Dinero: la elección del Admin (orquestador) o el camino automático.
  const automatic = Boolean(order.admin_pending_facts?.cancellationAutomatic)
  if (!moneyInvolved) {
    push("money", paymentReview ? "attention" : "not_required", paymentReview
      ? "Revisá el comprobante de pago antes de decidir un reintegro."
      : "No hubo pago confirmado: no hay dinero para devolver.")
  } else if (rejected) {
    push("money", "done", "Devolución del dinero rechazada.")
  } else if (refunded || financial?.mode === "resolution") {
    push("money", "done", refunded ? "Dinero resuelto." : "Destino del dinero elegido.")
  } else if (inspectionPending) {
    push("money", "waiting", "Se habilita al registrar la inspección de la devolución.")
  } else if (holdActive) {
    push("money", "waiting", "Se habilita cuando la mercadería vuelva al stock.")
  } else if (automatic) {
    push("money", "processing", "BEYONIX lo resuelve automáticamente.")
  } else {
    push("money", "current", "Elegí saldo a favor o reintegro externo.")
  }

  // 4. Nota de crédito: consecuencia de la resolución, nunca un paso aparte del Admin.
  if (!moneyInvolved) {
    push("credit_note", "not_required", "No corresponde.")
  } else if (creditNote.authorized) {
    push("credit_note", "done", "Nota de crédito emitida.")
  } else if (creditNote.state === "processing") {
    push("credit_note", "processing", "En proceso en ARCA.")
  } else if (rejected && creditNote.state !== "not_required") {
    // La obligación fiscal no depende de la decisión del dinero: se define en Facturación.
    push("credit_note", "attention", "Definí la nota de crédito en Facturación (sin devolver dinero).")
  } else if (creditNote.state === "error") {
    push("credit_note", "attention", "ARCA no la autorizó: revisala en Facturación.")
  } else if (creditNote.state === "required" || creditNote.state === "legacy_required" || hasPendingInvoiceObligation(order)) {
    push("credit_note", "waiting", "Se emite sola al confirmar el destino del dinero.")
  } else {
    push("credit_note", "not_required", "La venta no estaba facturada: no hace falta.")
  }

  // 5. Reintegro.
  const status = financial?.resolutionStatus ?? null
  if (!moneyInvolved) {
    push("refund", "not_required", "No corresponde.")
  } else if (rejected) {
    push("refund", "not_required", "No corresponde: la devolución del dinero fue rechazada.")
  } else if (refunded) {
    push("refund", "done", "Reintegro realizado.")
  } else if (status === "manual_pending" || next.state === "register_external_refund") {
    push("refund", "current", "Hacé la transferencia al cliente y cargá el comprobante.")
  } else if (status === "requires_action" || next.state === "reconcile_mp_refund") {
    push("refund", "attention", "Una actualización quedó pendiente: reintentala abajo.")
  } else if (status === "processing" || status === "reserved" || automatic ||
    (order.mercadopago_order_refunds ?? []).some((refund) => refund.status === "processing")) {
    push("refund", "processing", "Procesando el reintegro.")
  } else {
    push("refund", "waiting", "Se realiza al confirmar el destino del dinero.")
  }

  const finished = steps.every((step) => step.status === "done" || step.status === "not_required")
  push("finished", finished ? "done" : "waiting", finished ? "Cancelación completada." : "Quedan pasos pendientes.")
  const current = steps.find((step) => step.status === "current" || step.status === "attention")?.key ?? null
  return { steps, current, action, finished }
}
