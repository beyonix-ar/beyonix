/**
 * Acciones administrativas PENDIENTES de un pedido -- "¿qué me falta hacer
 * todavía?", nunca "¿qué pasó alguna vez?". Es la única fuente del contador
 * que se muestra sobre el botón "Ver pedido" del Admin.
 *
 * Pura y derivada del estado actual del pedido (sin I/O ni flags guardados):
 * mismo estado => mismo contador, sin drift. No decide reglas de negocio
 * nuevas: reutiliza las máquinas existentes (getCancellationNextAction para
 * cancelación/NC/reintegro, `admin_needs_action` de cada reclamo, que la base
 * mantiene, e isOrderPaymentConfirmed).
 *
 * Es distinto de la campana: la campana avisa EVENTOS nuevos (y se limpia al
 * leerlos); este contador sólo baja cuando la acción realmente se resuelve.
 */

import {
  getCancellationNextAction,
  type CancellationNextActionOrder,
} from "./cancellation-next-action.ts"
import { isOrderPaymentConfirmed } from "./order-payment-status.ts"

export type AdminPendingOrderActionKind =
  | "payment_review"
  | "payment_conflict"
  | "cancellation_request"
  | "invoice"
  | "credit_note"
  | "refund"
  | "claim"
  | "return"
  | "shipping"

export interface AdminPendingOrderAction {
  kind: AdminPendingOrderActionKind
  label: string
  /** Rojo en la UI: dinero, cancelación o reclamo de por medio. */
  urgent: boolean
}

export interface AdminPendingActionsOrder extends CancellationNextActionOrder {
  payment_proof_uploaded_at?: string | null
  transfer_verification_status?: string | null
  return_status?: string | null
  return_resolved_at?: string | null
  total?: number | string | null
  order_claims?: Array<{ id?: number | string | null; admin_needs_action?: boolean | null }> | null
}

const PAYMENT_CONFLICT_STATUSES = new Set([
  // Transferencia identificada en Mercado Pago pero sin stock para confirmar.
  "auto_verified_stock_conflict",
  // Pagos de Mercado Pago cobrados que no pudieron confirmarse.
  "approved_amount_mismatch",
  "approved_currency_mismatch",
  "approved_stock_conflict",
  "approved_after_cancellation",
])

const OPEN_RETURN_STATUSES = new Set(["solicitada", "en_revision", "aprobada"])

/** Estados de envío en los que el pedido ya salió o está en manos del correo. */
const SHIPPING_HANDLED_STATUSES = new Set([
  "preparado",
  "enviado",
  "en_camino",
  "entregado",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
])

const CANCELLATION_FLOW_FINANCIAL_STATUSES = new Set([
  "cancelled",
  "cancellation_requested",
  "refund_pending",
  "refunded",
])

function isRejectedPayment(order: AdminPendingActionsOrder) {
  return ["rechazado", "rejected"].includes(order.payment_status ?? "")
}

function isInvoiced(order: AdminPendingActionsOrder) {
  return order.invoice_status === "authorized" || Boolean(order.invoice_cae)
}

function isCancellationFlow(order: AdminPendingActionsOrder) {
  return (
    order.estado === "cancelado" ||
    CANCELLATION_FLOW_FINANCIAL_STATUSES.has(order.financial_status ?? "")
  )
}

/** Comprobante/verificación de transferencia esperando decisión manual. */
function needsTransferPaymentReview(order: AdminPendingActionsOrder) {
  if (order.payment_method_id !== "transferencia") return false
  if (order.estado === "cancelado") return false
  if (!["pendiente_comprobante", "en_revision", "pending"].includes(order.payment_status ?? "")) {
    return false
  }
  return (
    (Boolean(order.payment_proof_url) && order.payment_status === "en_revision") ||
    order.transfer_verification_status === "manual_review"
  )
}

/** Pago cobrado que no se pudo confirmar: se resuelve revisándolo o reintegrándolo. */
function hasUnresolvedPaymentConflict(order: AdminPendingActionsOrder) {
  if (!PAYMENT_CONFLICT_STATUSES.has(order.payment_status ?? "")) return false
  if (order.financial_status === "refunded") return false
  return !(order.mercadopago_order_refunds ?? []).some((refund) => refund.status === "confirmed")
}

export function getAdminPendingOrderActions(
  order: AdminPendingActionsOrder,
): AdminPendingOrderAction[] {
  const actions: AdminPendingOrderAction[] = []
  const add = (kind: AdminPendingOrderActionKind, label: string, urgent: boolean) => {
    if (!actions.some((action) => action.kind === kind)) actions.push({ kind, label, urgent })
  }

  // ── Pago ──
  if (needsTransferPaymentReview(order)) add("payment_review", "Revisar comprobante de pago", false)
  if (hasUnresolvedPaymentConflict(order)) add("payment_conflict", "Resolver pago cobrado sin confirmar", true)

  // ── Cancelación / nota de crédito / reintegro ──
  if (order.financial_status === "cancellation_requested") {
    // Primero hay que decidir la solicitud: si se rechaza, no hay reintegro.
    add("cancellation_request", "Resolver solicitud de cancelación", true)
  } else {
    const next = getCancellationNextAction(order)
    switch (next.state) {
      case "emit_credit_note":
        add("credit_note", "Emitir nota de crédito", true)
        add("refund", "Reintegrar el pago", true)
        break
      case "blocked":
        if (next.reason === "pending_payment_review") {
          add("payment_review", "Revisar comprobante de pago", false)
        } else if (next.reason === "invoice_missing") {
          add("invoice", "Emitir factura", false)
          add("credit_note", "Emitir nota de crédito", true)
          add("refund", "Reintegrar el pago", true)
        } else {
          add("refund", "Reintegrar el pago", true)
        }
        break
      case "wait_credit_note":
      case "register_external_refund":
      case "execute_mp_refund":
      case "reconcile_mp_refund":
        add("refund", "Reintegrar el pago", true)
        break
      case "none":
      case "completed":
        break
    }
  }

  // ── Facturación y envío del flujo normal (sólo pedidos pagados y vigentes) ──
  const activePaidOrder =
    !isCancellationFlow(order) &&
    !isRejectedPayment(order) &&
    !PAYMENT_CONFLICT_STATUSES.has(order.payment_status ?? "") &&
    isOrderPaymentConfirmed({
      ...order,
      payment_confirmed_amount:
        order.payment_confirmed_amount == null ? null : Number(order.payment_confirmed_amount),
    })

  if (activePaidOrder && Number(order.total ?? 0) > 0 && !isInvoiced(order)) {
    add("invoice", "Emitir factura", false)
  }
  if (
    activePaidOrder &&
    order.invoice_status === "authorized" &&
    Boolean(order.invoice_cae) &&
    !SHIPPING_HANDLED_STATUSES.has(order.estado ?? "")
  ) {
    add("shipping", "Preparar el envío", false)
  }

  // ── Reclamos (incluye reemplazos/devoluciones gestionados por reclamo) ──
  const claimsNeedingAction = (order.order_claims ?? []).filter(
    (claim) => claim.admin_needs_action === true,
  ).length
  for (let index = 0; index < claimsNeedingAction; index++) {
    actions.push({
      kind: "claim",
      label: claimsNeedingAction > 1 ? `Atender reclamo ${index + 1}` : "Atender reclamo",
      urgent: true,
    })
  }

  // ── Devolución a nivel pedido ──
  if (OPEN_RETURN_STATUSES.has(order.return_status ?? "") && !order.return_resolved_at) {
    add("return", "Resolver devolución", true)
  }

  return actions
}

export function getAdminPendingOrderActionCount(order: AdminPendingActionsOrder) {
  return getAdminPendingOrderActions(order).length
}

export function formatAdminPendingActionCount(count: number) {
  return count === 1 ? "1 acción pendiente" : `${count} acciones pendientes`
}
