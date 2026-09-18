/**
 * Traduce getCancellationNextAction (la única fuente de verdad de qué
 * necesita un pedido cancelado) a un modelo de vista listo para renderizar:
 * pasos, importes, método de pago en lenguaje humano y la acción principal.
 *
 * Pura, sin React ni fetch -- así se puede testear con node --test y
 * garantizar que el panel nunca decide una regla de negocio por su cuenta
 * (sección 16 de la auditoría: "la UI NO debe decidir reglas financieras").
 */

import {
  getCancellationNextAction,
  getCancellationNextActionCopy,
  getLatestMercadoPagoRefund,
  type CancellationNextActionOrder,
  type CancellationNextActionState,
} from "./cancellation-next-action.ts"

export type CancellationPanelStepStatus = "done" | "pending" | "processing" | "attention"

export interface CancellationPanelStep {
  key: "credit_note" | "refund"
  label: string
  status: CancellationPanelStepStatus
}

export type CancellationPaymentMethodKind =
  | "mercadopago"
  | "transferencia"
  | "saldo"
  | "saldo_transferencia"
  | "saldo_mercadopago"
  | "otro"

export interface CancellationPanelAmounts {
  /** Total facturado/del pedido -- valor fiscal, no necesariamente lo que hay que reintegrar. */
  orderTotal: number
  /** Saldo a favor ya devuelto a la billetera (0 si no se usó saldo). */
  balanceRestored: number
  /** Dinero externo (MP/transferencia) efectivamente cobrado. */
  externalPaid: number
  /** Importe que corresponde reintegrar por el medio externo. */
  amountToRefund: number
  /**
   * true cuando amountToRefund viene de un dato ya persistido y validado
   * server-side (NC autorizada, o el monto exacto que usará el refund de
   * Mercado Pago) -- false cuando es sólo una estimación previa a emitir la
   * NC (para mostrar "importe real a reintegrar" antes del paso 1).
   */
  amountIsFinal: boolean
  /**
   * De dónde sale amountToRefund cuando el estado es register_external_refund
   * -- sólo para mostrar la leyenda correcta ("definido por la nota
   * autorizada" vs. "monto confirmado del pago"), nunca para decidir nada.
   * Irrelevante (false) en cualquier otro estado.
   */
  amountFromCreditNote: boolean
}

export type CancellationPanelActionKind =
  | "go_to_billing"
  | "register_external_refund"
  | "execute_mp_refund"
  | "reconcile_mp_refund"
  | "review_payment"

export interface CancellationPanelPrimaryAction {
  kind: CancellationPanelActionKind
  label: string
}

export interface CancellationPanelViewModel {
  isCancellationFlow: boolean
  state: CancellationNextActionState
  isFinished: boolean
  badgeTone: "success" | "warning" | "danger" | "info"
  paymentMethod: CancellationPaymentMethodKind
  amounts: CancellationPanelAmounts
  /** 1 o 2 pasos según si esta cancelación necesita nota de crédito. Vacío si todavía no hay pago confirmado. */
  steps: CancellationPanelStep[]
  currentStepIndex: number | null
  primaryAction: CancellationPanelPrimaryAction | null
  helperText: string
  /** Nota informativa extra (p.ej. "Procesando con Mercado Pago...") -- nunca decide el estado, sólo lo complementa. */
  statusNote: string | null
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

function estimateExternalPaid(order: CancellationNextActionOrder): number {
  const confirmed = Number(order.payment_confirmed_amount ?? 0)
  if (confirmed > 0) return roundMoney(confirmed)
  const due = Number((order as { external_amount_due?: number | string | null }).external_amount_due ?? 0)
  if (due > 0) return roundMoney(due)
  return 0
}

function getPaymentMethodKind(
  order: CancellationNextActionOrder,
  balanceRestored: number,
): CancellationPaymentMethodKind {
  const method = order.payment_method_id
  const usedBalance = balanceRestored > 0.01

  if (method === "customer_credit") return "saldo"
  if (method === "mercadopago") return usedBalance ? "saldo_mercadopago" : "mercadopago"
  if (method === "transferencia") return usedBalance ? "saldo_transferencia" : "transferencia"
  return "otro"
}

function badgeToneForState(state: CancellationNextActionState): CancellationPanelViewModel["badgeTone"] {
  switch (state) {
    case "completed":
      return "success"
    case "none":
      return "success"
    case "wait_credit_note":
      return "info"
    case "reconcile_mp_refund":
    case "blocked":
      return "danger"
    default:
      return "warning"
  }
}

export function getCancellationPanelViewModel(
  order: CancellationNextActionOrder & {
    total?: number | string | null
    external_amount_due?: number | string | null
    /**
     * Monto real de customer_credit_movements (movement_type='reversal'),
     * calculado server-side en app/api/admin/pedidos/route.ts. Cuando está
     * presente reemplaza la estimación (total - externo pagado): esta última
     * puede desviarse del valor real cuando hubo descuentos, envío con costo,
     * o ajustes manuales de la NC.
     */
    customer_credit_restored_amount?: number | string | null
    order_credit_notes?: Array<{
      status?: string | null
      destination?: string | null
      settlement_status?: string | null
      total_amount?: number | string | null
    }> | null
  },
): CancellationPanelViewModel {
  const nextAction = getCancellationNextAction(order)
  const isCancellationFlow =
    order.estado === "cancelado" ||
    ["cancelled", "cancellation_requested", "refund_pending", "refunded"].includes(
      order.financial_status ?? "",
    )

  const orderTotal = roundMoney(Number(order.total ?? 0))
  const externalPaid = estimateExternalPaid(order)
  const restoredAmount = Number(order.customer_credit_restored_amount ?? Number.NaN)
  const balanceRestored = Number.isFinite(restoredAmount)
    ? roundMoney(restoredAmount)
    : roundMoney(Math.max(orderTotal - externalPaid, 0))
  const paymentMethod = getPaymentMethodKind(order, balanceRestored)

  const notes = order.order_credit_notes ?? []
  const flowNeedsCreditNote =
    Boolean(order.credit_note_required) || notes.length > 0
  const hasAnyAuthorizedNote = notes.some((note) => note.status === "authorized")
  const pendingExternalRefundAmount = roundMoney(
    notes
      .filter(
        (note) =>
          note.status === "authorized" &&
          note.destination === "external_refund" &&
          note.settlement_status !== "completado",
      )
      .reduce((sum, note) => sum + Number(note.total_amount ?? 0), 0),
  )
  const mpRefund = getLatestMercadoPagoRefund(order)

  let amountToRefund = externalPaid
  let amountIsFinal = false
  if (nextAction.state === "register_external_refund") {
    // Con NC autorizada pendiente de liquidar, el monto final es el de la
    // NC. Sin NC (pedido nunca facturado, migración
    // 20260917130000_...): externalPaid ya es el mismo
    // REFUNDABLE_EXTERNAL_AMOUNT que calculará commit_order_refund_proof
    // server-side (payment_confirmed_amount/external_amount_due, que ya
    // excluyen el saldo usado) -- también es un monto final, no una
    // estimación previa a una NC todavía sin emitir.
    amountToRefund = pendingExternalRefundAmount > 0 ? pendingExternalRefundAmount : externalPaid
    amountIsFinal = true
  } else if (nextAction.state === "execute_mp_refund" || nextAction.state === "reconcile_mp_refund") {
    amountIsFinal = true
  } else if (nextAction.state === "completed") {
    amountToRefund =
      pendingExternalRefundAmount > 0
        ? pendingExternalRefundAmount
        : mpRefund?.status === "confirmed"
          ? roundMoney(Number(externalPaid))
          : externalPaid
    amountIsFinal = true
  }

  const steps: CancellationPanelStep[] = []
  const isFinished = nextAction.state === "completed"

  if (isCancellationFlow && nextAction.state !== "none") {
    if (flowNeedsCreditNote) {
      steps.push({
        key: "credit_note",
        label: "Nota de crédito",
        status:
          isFinished || hasAnyAuthorizedNote
            ? "done"
            : nextAction.state === "wait_credit_note"
              ? "processing"
              : nextAction.reason === "invoice_missing"
                ? "attention"
                : "pending",
      })
    }
    steps.push({
      key: "refund",
      label: "Reintegro",
      status: isFinished
        ? "done"
        : nextAction.state === "reconcile_mp_refund" ||
            nextAction.reason === "no_automatic_refund_path"
          ? "attention"
          : nextAction.state === "register_external_refund" ||
              nextAction.state === "execute_mp_refund"
            ? "pending"
            : mpRefund?.status === "processing"
              ? "processing"
              : "pending",
    })
  }

  const currentStepIndex = (() => {
    if (steps.length === 0) return null
    const activeIndex = steps.findIndex((step) => step.status !== "done")
    return activeIndex === -1 ? steps.length : activeIndex + 1
  })()

  const primaryAction: CancellationPanelPrimaryAction | null = (() => {
    switch (nextAction.state) {
      case "emit_credit_note":
        return { kind: "go_to_billing", label: "Emitir nota de crédito" }
      case "register_external_refund":
        return { kind: "register_external_refund", label: "Registrar reintegro" }
      case "execute_mp_refund":
        return { kind: "execute_mp_refund", label: "Reintegrar por Mercado Pago" }
      case "reconcile_mp_refund":
        return { kind: "reconcile_mp_refund", label: "Revisar reintegro" }
      case "blocked":
        return nextAction.reason === "pending_payment_review"
          ? { kind: "review_payment", label: "Revisar comprobante de pago" }
          : nextAction.reason === "invoice_missing"
            ? { kind: "go_to_billing", label: "Ir a Facturación" }
            : null
      default:
        return null
    }
  })()

  const copy = getCancellationNextActionCopy(nextAction.state, nextAction.reason)
  const helperText =
    copy?.description ??
    (nextAction.state === "completed"
      ? "El reintegro quedó registrado. No hay más acciones pendientes para esta cancelación."
      : "No hay ninguna acción financiera pendiente para esta cancelación.")

  const statusNote = (() => {
    if (
      (paymentMethod === "mercadopago" || paymentMethod === "saldo_mercadopago") &&
      mpRefund?.status === "processing" &&
      nextAction.state !== "reconcile_mp_refund"
    ) {
      return "Procesando el reintegro con Mercado Pago..."
    }
    return null
  })()

  return {
    isCancellationFlow,
    state: nextAction.state,
    isFinished,
    badgeTone: badgeToneForState(nextAction.state),
    paymentMethod,
    amounts: {
      orderTotal,
      balanceRestored,
      externalPaid,
      amountToRefund,
      amountIsFinal,
      amountFromCreditNote:
        nextAction.state === "register_external_refund" && pendingExternalRefundAmount > 0,
    },
    steps,
    currentStepIndex,
    primaryAction,
    helperText,
    statusNote,
  }
}
