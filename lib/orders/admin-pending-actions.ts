/**
 * Acciones HUMANAS pendientes de un pedido: lo que el Admin tiene que hacer
 * y BEYONIX no puede resolver solo. Es la única fuente del contador del
 * listado, de las etiquetas de cada fila y de las tareas de pedidos de la
 * campana.
 *
 * Pura y derivada del estado actual (sin I/O): mismo estado => mismas
 * acciones. No decide reglas nuevas: reutiliza getCancellationNextAction, el
 * modo/estado del orquestador financiero (Etapa 5, vía `admin_pending_facts`),
 * los bloqueos de despacho, `admin_needs_action` de cada reclamo y el estado
 * de la facturación automática. Lo automático (factura en cola, NC en ARCA,
 * reintegro en proceso) se informa aparte y nunca suma al contador.
 */

import {
  getCancellationNextAction,
  type CancellationNextActionOrder,
} from "./cancellation-next-action.ts"
import { claimNeedsAdminAttention } from "./claim-attention.ts"
import { isOrderPaymentConfirmed } from "./order-payment-status.ts"

export type AdminPendingOrderActionKind =
  | "payment_review"
  | "payment_conflict"
  | "cancellation_request"
  | "refund"
  | "refund_manual"
  | "refund_retry"
  | "advanced_case"
  | "invoice"
  | "claim"
  | "return"
  | "dispatch_blocked"
  | "dispatch_prepare"
  | "shipping"

/** 1: urgente (dinero, reclamo, bloqueo). 2: operativa. */
export type AdminPendingActionPriority = 1 | 2

export interface AdminPendingOrderAction {
  kind: AdminPendingOrderActionKind
  label: string
  /** true en prioridad 1: rojo en la UI. */
  urgent: boolean
  priority: AdminPendingActionPriority
  /** Destino directo de la acción (sólo navegación). */
  href: string
}

/** Hechos server-side que el pedido no trae en sus columnas. */
export interface AdminPendingFacts {
  financial: {
    mode: "wizard" | "resolution" | "advanced" | "none"
    /** Estado de la resolución elegida (order_financial_resolutions.status). */
    resolutionStatus: string | null
    /** La API ofrece hoy al menos una opción ejecutable. */
    hasOptions: boolean
  } | null
  dispatch: {
    batchId: number | null
    batchStatus: "open" | "closed" | "handed_over" | null
    packageStatus: "preparing" | "prepared" | null
    blocked: boolean
  } | null
  /**
   * El worker automático de ARCA va a tomar esta factura (misma regla que su
   * cola + arcaAutoInvoicingView). Ausente = desconocido: se
   * trata como tarea humana para no ocultar trabajo.
   */
  invoiceAutomatic?: boolean
}

export interface AdminPendingActionsOrder extends CancellationNextActionOrder {
  id?: number
  payment_proof_uploaded_at?: string | null
  transfer_verification_status?: string | null
  return_status?: string | null
  return_resolved_at?: string | null
  total?: number | string | null
  invoice_next_attempt_at?: string | null
  shipping_provider?: string | null
  envio_proveedor?: string | null
  andreani_handed_over_at?: string | null
  orden_items?: Array<{ return_inventory_processed_at?: string | null }> | null
  order_claims?: Array<{
    id?: number | string | null
    admin_needs_action?: boolean | null
    status?: string | null
    failure_type?: string | null
    first_reviewed_at?: string | null
    last_customer_message_at?: string | null
    last_admin_response_at?: string | null
  }> | null
  admin_pending_facts?: AdminPendingFacts | null
}

export interface AdminOrderWork {
  actions: AdminPendingOrderAction[]
  /** Estados informativos (procesos automáticos o esperas): nunca pendientes. */
  automatic: string[]
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
const RETURN_ARRIVED_STATUSES = new Set(["en_revision", "aprobada", "rechazada", "resuelta"])

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

export const ADMIN_PENDING_ACTION_LABELS: Record<AdminPendingOrderActionKind, string> = {
  payment_review: "Revisar pago",
  payment_conflict: "Resolver pago",
  cancellation_request: "Resolver cancelación",
  refund: "Resolver reintegro",
  refund_manual: "Registrar reintegro",
  refund_retry: "Reintentar actualización",
  advanced_case: "Revisar caso avanzado",
  invoice: "Emitir factura",
  claim: "Resolver reclamo",
  return: "Revisar devolución",
  dispatch_blocked: "Retirar del despacho",
  dispatch_prepare: "Preparar despacho",
  shipping: "Preparar envío",
}

const ACTION_PRIORITY: Record<AdminPendingOrderActionKind, AdminPendingActionPriority> = {
  payment_review: 2,
  payment_conflict: 1,
  cancellation_request: 1,
  refund: 1,
  refund_manual: 1,
  refund_retry: 1,
  advanced_case: 1,
  invoice: 2,
  claim: 1,
  return: 2,
  dispatch_blocked: 1,
  dispatch_prepare: 2,
  shipping: 2,
}

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

function isAndreaniOrder(order: AdminPendingActionsOrder) {
  return (order.shipping_provider || order.envio_proveedor || "").toLowerCase() === "andreani"
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

function orderHref(order: AdminPendingActionsOrder, tab: string) {
  return order.id ? `/admin/pedidos/${order.id}?tab=${tab}` : `/admin/pedidos?tab=${tab}`
}

/**
 * Reintegro de una cancelación. Con los hechos del orquestador (Etapa 5/6)
 * el estado de la resolución manda; sin ellos se traduce la máquina previa,
 * con la NC como paso automático (nunca una segunda acción del Admin).
 */
function addFinancialWork(
  order: AdminPendingActionsOrder,
  add: (kind: AdminPendingOrderActionKind, href: string) => void,
  automatic: Set<string>,
) {
  const cancellation = orderHref(order, "cancelacion")
  const financial = order.admin_pending_facts?.financial
  if (financial && financial.mode !== "none") {
    if (financial.mode === "resolution") {
      if (financial.resolutionStatus === "manual_pending") add("refund_manual", cancellation)
      else if (financial.resolutionStatus === "requires_action") add("refund_retry", cancellation)
      else if (financial.resolutionStatus !== "completed") automatic.add("Reintegro en proceso")
    } else if (financial.mode === "advanced") {
      add("advanced_case", cancellation)
    } else if (financial.hasOptions) {
      add("refund", cancellation)
    } else {
      automatic.add("Esperando la recepción del producto")
    }
    return
  }

  const next = getCancellationNextAction(order)
  switch (next.state) {
    case "blocked":
      if (next.reason === "pending_payment_review") add("payment_review", orderHref(order, "pago"))
      else if (next.reason === "invoice_missing") add("invoice", orderHref(order, "facturacion"))
      else add("refund", cancellation)
      break
    case "emit_credit_note":
    case "register_external_refund":
    case "execute_mp_refund":
      add("refund", cancellation)
      break
    case "reconcile_mp_refund":
      add("refund_retry", cancellation)
      break
    case "wait_credit_note":
      automatic.add("Nota de crédito en proceso")
      break
    case "none":
    case "completed":
      break
  }
}

/**
 * Factura C: sólo es automática si el worker de ARCA realmente la va a tomar
 * (facturación automática activa y la factura dentro de su cola). Con el
 * automático apagado, fuera del corte o sin dato, emitirla es tarea humana.
 */
function addInvoiceWork(
  order: AdminPendingActionsOrder,
  add: (kind: AdminPendingOrderActionKind, href: string, label?: string) => void,
  automatic: Set<string>,
) {
  if (order.invoice_status === "processing") automatic.add("Facturación en curso")
  else if (order.admin_pending_facts?.invoiceAutomatic === true) {
    automatic.add(order.invoice_status === "error" ? "Facturación: reintento automático" : "Facturación automática programada")
  } else add("invoice", orderHref(order, "facturacion"), order.invoice_status === "error" ? "Revisar factura" : undefined)
}

function addDispatchWork(
  order: AdminPendingActionsOrder,
  add: (kind: AdminPendingOrderActionKind, href: string) => void,
  automatic: Set<string>,
) {
  const dispatch = order.admin_pending_facts?.dispatch
  if (order.andreani_handed_over_at || dispatch?.batchStatus === "handed_over") return
  // La entrega al transporte es UNA acción por tanda (Despachos/campana); el pedido sólo informa.
  if (dispatch?.batchId && dispatch.batchStatus === "closed") {
    automatic.add("En tanda lista para entregar al transporte")
    return
  }
  add("dispatch_prepare", dispatch?.batchId
    ? `/admin/despachos?batch=${dispatch.batchId}`
    : `/admin/despachos?order=${order.id ?? ""}`)
}

export function getAdminOrderWork(order: AdminPendingActionsOrder): AdminOrderWork {
  const actions: AdminPendingOrderAction[] = []
  const automatic = new Set<string>()
  const add = (kind: AdminPendingOrderActionKind, href: string, label = ADMIN_PENDING_ACTION_LABELS[kind]) => {
    if (actions.some((action) => action.kind === kind)) return
    const priority = ACTION_PRIORITY[kind]
    actions.push({ kind, label, urgent: priority === 1, priority, href })
  }

  // ── Despacho bloqueado: aunque el pedido esté cancelado, sigue en la tanda ──
  const dispatch = order.admin_pending_facts?.dispatch
  if (dispatch?.blocked && dispatch.batchId && dispatch.batchStatus !== "handed_over" && !order.andreani_handed_over_at) {
    add("dispatch_blocked", `/admin/despachos?batch=${dispatch.batchId}`)
  }

  // ── Pago ──
  if (needsTransferPaymentReview(order)) add("payment_review", orderHref(order, "pago"))
  if (hasUnresolvedPaymentConflict(order)) add("payment_conflict", orderHref(order, "pago"))

  // ── Cancelación / reintegro ──
  if (order.financial_status === "cancellation_requested") {
    // Primero hay que decidir la solicitud: si se rechaza, no hay reintegro.
    add("cancellation_request", orderHref(order, "cancelacion"))
  } else {
    addFinancialWork(order, add, automatic)
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
    addInvoiceWork(order, add, automatic)
  }
  if (
    activePaidOrder &&
    order.invoice_status === "authorized" &&
    Boolean(order.invoice_cae) &&
    !SHIPPING_HANDLED_STATUSES.has(order.estado ?? "") &&
    !actions.some((action) => action.kind === "dispatch_blocked")
  ) {
    if (isAndreaniOrder(order)) addDispatchWork(order, add, automatic)
    else add("shipping", orderHref(order, "envio"))
  }

  // ── Reclamos (incluye reemplazos/devoluciones gestionados por reclamo) ──
  // Misma regla que la campana y Atención al cliente. La solicitud de
  // cancelación tiene su propia acción (arriba): no se cuenta dos veces.
  const claimsNeedingAction = (order.order_claims ?? []).filter(
    (claim) => claim.failure_type !== "cancelar_compra" && claimNeedsAdminAttention(claim),
  ).length
  for (let index = 0; index < claimsNeedingAction; index++) {
    actions.push({ kind: "claim", label: ADMIN_PENDING_ACTION_LABELS.claim, urgent: true, priority: 1, href: orderHref(order, "atencion") })
  }

  // ── Devolución a nivel pedido ──
  if (OPEN_RETURN_STATUSES.has(order.return_status ?? "") && !order.return_resolved_at) {
    add("return", orderHref(order, "atencion"))
  }
  // Producto devuelto que llegó y todavía no tiene destino de stock definido.
  const productArrived = order.estado === "devuelto_beyonix" || RETURN_ARRIVED_STATUSES.has(order.return_status ?? "")
  if (productArrived && (order.orden_items ?? []).some((item) => !item.return_inventory_processed_at)) {
    add("return", orderHref(order, "atencion"))
  }

  // Prioridad 1 primero; dentro de cada nivel, el orden de arriba.
  actions.sort((left, right) => left.priority - right.priority)
  return { actions, automatic: [...automatic] }
}

export function getAdminPendingOrderActions(order: AdminPendingActionsOrder): AdminPendingOrderAction[] {
  return getAdminOrderWork(order).actions
}

export function getAdminPendingOrderActionCount(order: AdminPendingActionsOrder) {
  return getAdminPendingOrderActions(order).length
}

export function formatAdminPendingActionCount(count: number) {
  return count === 1 ? "1 acción pendiente" : `${count} acciones pendientes`
}

/** Etiquetas visibles en la fila: sin repetir y con el resto resumido. */
export function summarizeAdminPendingActions(actions: AdminPendingOrderAction[], visible: number) {
  const labels: AdminPendingOrderAction[] = []
  for (const action of actions) {
    if (!labels.some((item) => item.label === action.label)) labels.push(action)
  }
  const shown = labels.slice(0, visible)
  const hidden = actions.length - actions.filter((action) => shown.some((item) => item.label === action.label)).length
  return { shown, hidden }
}
