/**
 * Fuente única de la "próxima acción" administrativa para una cancelación
 * con pago confirmado. Antes de esto, cada consumidor (notificaciones del
 * admin, `getOrderRecommendedAction`, `RefundManagementPanel`) interpretaba
 * por su cuenta financial_status/credit_note_required/order_credit_notes/
 * mercadopago_order_refunds -- con criterios ligeramente distintos entre sí
 * (ver auditoría Fase 2). Esta función es la única que debe decidir "qué
 * necesita este pedido ahora"; los consumidores sólo traducen el resultado
 * a texto/routing.
 *
 * No ejecuta nada, no llama RPCs, no tiene efectos secundarios: es pura,
 * sincrónica, y opera exclusivamente sobre los campos ya cargados del
 * pedido.
 */

export type CancellationNextActionState =
  | "none"
  | "emit_credit_note"
  | "wait_credit_note"
  | "execute_mp_refund"
  | "reconcile_mp_refund"
  | "register_external_refund"
  | "completed"
  | "blocked"

export interface CancellationNextActionCreditNote {
  status?: string | null
  destination?: string | null
  settlement_status?: string | null
  total_amount?: number | string | null
}

export interface CancellationNextActionMercadoPagoRefund {
  status?: string | null
  created_at?: string | null
}

export interface CancellationNextActionOrder {
  estado?: string | null
  financial_status?: string | null
  payment_method_id?: string | null
  payment_status?: string | null
  paid_at?: string | null
  payment_confirmed_amount?: number | string | null
  payment_proof_url?: string | null
  invoice_status?: string | null
  invoice_cae?: string | null
  credit_note_required?: boolean | null
  order_credit_notes?: CancellationNextActionCreditNote[] | null
  mercadopago_order_refunds?: CancellationNextActionMercadoPagoRefund[] | null
}

export type CancellationBlockedReason =
  | "pending_payment_review"
  | "invoice_missing"
  | "no_automatic_refund_path"

export interface CancellationNextAction {
  state: CancellationNextActionState
  /** true cuando hay algo concreto que un admin debe hacer ahora mismo. */
  urgent: boolean
  /**
   * Sólo presente cuando state='blocked': por qué, en términos que un
   * consumidor (panel/notificación) puede traducir a texto humano sin
   * tener que re-derivar la condición. No cambia ninguna decisión de
   * negocio, sólo documenta la ya tomada arriba.
   */
  reason?: CancellationBlockedReason
}

function isCancellationFlow(order: CancellationNextActionOrder): boolean {
  return (
    order.estado === "cancelado" ||
    ["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
      order.financial_status ?? "",
    )
  )
}

function isPaymentConfirmedForRefund(order: CancellationNextActionOrder): boolean {
  return (
    Boolean(order.paid_at) ||
    Number(order.payment_confirmed_amount ?? 0) > 0 ||
    ["confirmado", "approved", "confirmed"].includes(order.payment_status ?? "")
  )
}

function hasPaymentProofPendingReview(order: CancellationNextActionOrder): boolean {
  return (
    Boolean(order.payment_proof_url) &&
    ["en_revision", "pendiente_comprobante", "pending"].includes(
      order.payment_status ?? "",
    )
  )
}

/**
 * Mismo criterio que `isRefundPaymentAttentionOrder`/`hasCancellationAdminAttention`
 * (lib/admin/admin-notifications.ts, app/admin/sections/pedidos/admin-pedidos.tsx):
 * ¿esta cancelación tiene dinero confirmado de por medio, es decir corresponde
 * algún tipo de reintegro?
 */
function needsRefundAction(order: CancellationNextActionOrder): boolean {
  if (order.financial_status === "refunded") return false
  if (order.financial_status === "refund_pending") return true
  if (order.financial_status === "cancellation_requested") {
    return isPaymentConfirmedForRefund(order)
  }
  return order.estado === "cancelado" && isPaymentConfirmedForRefund(order)
}

function isOrderInvoiced(order: CancellationNextActionOrder): boolean {
  return order.invoice_status === "authorized" && Boolean(order.invoice_cae)
}

/**
 * Última tentativa de refund de Mercado Pago para este pedido. Expuesta
 * para que un consumidor (p.ej. el panel de cancelación) pueda mostrar un
 * matiz informativo (como "reintegro en curso") sin re-derivar la lógica de
 * decisión -- esto NUNCA determina el estado devuelto por
 * getCancellationNextAction, sólo lo complementa para mostrar.
 */
export function getLatestMercadoPagoRefund(
  order: CancellationNextActionOrder,
): CancellationNextActionMercadoPagoRefund | null {
  return latestMercadoPagoRefund(order)
}

function latestMercadoPagoRefund(
  order: CancellationNextActionOrder,
): CancellationNextActionMercadoPagoRefund | null {
  const refunds = order.mercadopago_order_refunds ?? []
  if (refunds.length === 0) return null

  return [...refunds].sort((a, b) => {
    const left = a.created_at ? new Date(a.created_at).getTime() : 0
    const right = b.created_at ? new Date(b.created_at).getTime() : 0
    return right - left
  })[0]
}

export function getCancellationNextAction(
  order: CancellationNextActionOrder,
): CancellationNextAction {
  if (!isCancellationFlow(order)) {
    return { state: "none", urgent: false }
  }

  if (order.financial_status === "refunded") {
    return { state: "completed", urgent: false }
  }

  if (!needsRefundAction(order)) {
    // Cancelación sin pago confirmado: nada financiero que reintegrar. Un
    // comprobante todavía en revisión es una decisión aparte (confirmar o
    // rechazar el pago) que no tiene un estado propio en esta máquina --
    // se marca `blocked` para no fingir que no hay nada pendiente, sin
    // inventar una acción de reintegro que todavía no corresponde.
    if (hasPaymentProofPendingReview(order)) {
      return { state: "blocked", urgent: true, reason: "pending_payment_review" }
    }
    return { state: "none", urgent: false }
  }

  const notes = order.order_credit_notes ?? []
  const hasProcessingNote = notes.some((note) => note.status === "processing")
  if (hasProcessingNote) {
    return { state: "wait_credit_note", urgent: false }
  }

  const mpRefund = latestMercadoPagoRefund(order)
  if (mpRefund?.status === "needs_reconciliation") {
    return { state: "reconcile_mp_refund", urgent: true }
  }

  const pendingExternalRefundNotes = notes.filter(
    (note) =>
      note.status === "authorized" &&
      note.destination === "external_refund" &&
      note.settlement_status !== "completado",
  )
  if (pendingExternalRefundNotes.length > 0) {
    return { state: "register_external_refund", urgent: true }
  }

  // ¿Ya existe una NC autorizada que mueve dinero? (customer_balance se
  // liquida atómicamente al autorizarse -- si seguimos con refund_pending
  // acá, esa NC no puede ser la causa; sólo importa para no volver a pedir
  // una NC que ya se emitió con otro destino.)
  const hasAuthorizedMoneyMovingNote = notes.some(
    (note) => note.status === "authorized" && note.destination !== "none",
  )

  if (!hasAuthorizedMoneyMovingNote) {
    if (order.credit_note_required) {
      if (!isOrderInvoiced(order)) {
        // begin_partial_credit_note exige AUTHORIZED_INVOICE_REQUIRED: el
        // bloqueo real está en emitir la factura (Facturación), no en la NC.
        return { state: "blocked", urgent: true, reason: "invoice_missing" }
      }
      return { state: "emit_credit_note", urgent: true }
    }

    // No requiere NC (p.ej. nunca llegó a facturarse antes de cancelarse).
    // Mercado Pago puede reintegrarse sin NC (begin_mercadopago_order_refund
    // no la exige). Cualquier otro medio (transferencia) también tiene un
    // camino registrable sin NC desde la migración
    // 20260917130000_external_refund_without_credit_note_and_mp_nc_policy:
    // commit_order_refund_proof calcula el monto reintegrable directo
    // (REFUNDABLE_EXTERNAL_AMOUNT) cuando no hay ninguna NC que mueva dinero
    // y credit_note_required es false, sin exigir una NC autorizada.
    if (order.payment_method_id === "mercadopago") {
      if (!mpRefund || mpRefund.status === "failed") {
        return { state: "execute_mp_refund", urgent: true }
      }
      return { state: "none", urgent: false }
    }

    return { state: "register_external_refund", urgent: true }
  }

  // Ya hay una NC autorizada que mueve dinero, pero no hacia 'external_refund'
  // (p.ej. se acreditó a customer_credit) -- si el medio externo sigue
  // necesitando reintegro, no hay ninguna NC pendiente de la que
  // commit_order_refund_proof pueda tomar el monto, y tampoco corresponde
  // colar este pedido por el camino "sin NC" (sí existe una NC autorizada,
  // sólo que con el destino equivocado para esto). El remanente, si es
  // Mercado Pago, igual puede reintegrarse directo.
  if (order.payment_method_id === "mercadopago") {
    if (!mpRefund || mpRefund.status === "failed") {
      return { state: "execute_mp_refund", urgent: true }
    }
    return { state: "none", urgent: false }
  }

  return { state: "blocked", urgent: true, reason: "no_automatic_refund_path" }
}

export interface CancellationNextActionCopy {
  title: string
  description: string
  /** Pestaña del admin donde vive la acción -- valores de AdminOrderDetailView. */
  tab: "facturacion" | "cancelacion" | "pago"
}

/**
 * Texto único para notificación/recomendación por estado. `null` para
 * "none"/"completed": ahí no corresponde generar ninguna alerta. `reason`
 * (sólo relevante para "blocked") afina el texto sin agregar una decisión
 * nueva -- viene de getCancellationNextAction.
 */
export function getCancellationNextActionCopy(
  state: CancellationNextActionState,
  reason?: CancellationBlockedReason,
): CancellationNextActionCopy | null {
  if (state === "blocked") {
    if (reason === "pending_payment_review") {
      return {
        title: "Revisar comprobante de pago",
        description:
          "El pedido se canceló con un comprobante todavía sin revisar. Confirmá o rechazá el pago antes de decidir si corresponde un reintegro.",
        tab: "pago",
      }
    }
    if (reason === "invoice_missing") {
      return {
        title: "Emitir la factura primero",
        description:
          "El pago está confirmado pero el pedido todavía no tiene factura autorizada. Facturalo para poder emitir la nota de crédito.",
        tab: "facturacion",
      }
    }
    if (reason === "no_automatic_refund_path") {
      return {
        title: "Registrar reintegro manualmente",
        description:
          "Ya se emitió una nota de crédito para este pedido, pero no acredita el reintegro externo pendiente. El sistema no tiene hoy un camino automático para este caso -- coordinalo por fuera y avisá a soporte técnico.",
        tab: "cancelacion",
      }
    }
    return {
      title: "Cancelación requiere revisión manual",
      description:
        "El pedido está cancelado con pago confirmado, pero no hay un camino automático de reintegro disponible para este caso.",
      tab: "cancelacion",
    }
  }

  switch (state) {
    case "emit_credit_note":
      return {
        title: "Emitir nota de crédito",
        description:
          "El pedido está cancelado con pago confirmado y necesita una nota de crédito antes de poder reintegrar.",
        tab: "facturacion",
      }
    case "wait_credit_note":
      return {
        title: "Nota de crédito en trámite",
        description:
          "La nota de crédito está esperando la respuesta de ARCA. Todavía no hay una acción pendiente.",
        tab: "facturacion",
      }
    case "register_external_refund":
      return {
        title: "Registrar reintegro",
        description:
          "La nota de crédito ya fue autorizada. Sólo falta cargar el comprobante de la devolución.",
        tab: "cancelacion",
      }
    case "execute_mp_refund":
      return {
        title: "Ejecutar reintegro de Mercado Pago",
        description: "El pedido está cancelado y listo para reintegrar por Mercado Pago.",
        tab: "cancelacion",
      }
    case "reconcile_mp_refund":
      return {
        title: "Revisar reintegro de Mercado Pago",
        description:
          "El reintegro de Mercado Pago quedó en un estado incierto y necesita revisión manual.",
        tab: "cancelacion",
      }
    case "none":
    case "completed":
      return null
  }
}
