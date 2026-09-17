import { isOrderPaymentConfirmed } from "./order-payment-status.ts"

export type AdminOrderCancellationAction = "reject" | "cancel"

export const ADMIN_ORDER_CANCELLATION_REASONS: Array<{ value: string; label: string }> = [
  { value: "solicitud_cliente", label: "Solicitud del cliente" },
  { value: "pago_no_recibido", label: "Pago no recibido" },
  { value: "pago_invalido", label: "Pago inválido" },
  { value: "falta_stock", label: "Falta de stock" },
  { value: "error_administrativo", label: "Error administrativo" },
  { value: "otro", label: "Otro" },
]

export const ADMIN_ORDER_CANCELLATION_OTHER_REASON = "otro"

const DISPATCHED_ORDER_STATUSES = [
  "enviado",
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
  "entregado",
]

const DISPATCHED_ANDREANI_FRAGMENTS = [
  "camino",
  "tránsito",
  "transito",
  "distribución",
  "distribucion",
  "reparto",
  "visita",
  "entregado",
]

interface OrderForCancellationEligibility {
  estado?: string | null
  tracking_number?: string | null
  andreani_tracking?: string | null
  andreani_envio_id?: string | null
  andreani_estado?: string | null
  andreani_creation_status?: string | null
  invoice_status?: string | null
  invoice_cae?: string | null
  invoice_number?: number | null
  invoice_point?: number | null
  payment_status?: string | null
  payment_confirmed_amount?: number | null
  paid_at?: string | null
  financial_status?: string | null
}

/**
 * Mismo guard que ahora bloquea las 3 RPCs de cancelación (Parte 1,
 * 20260916100000_block_cancellation_during_andreani_creation.sql): una
 * creación Andreani en curso o con resultado externo ambiguo. Acá, sólo
 * evita mostrar/habilitar un botón que la RPC va a rechazar igual --
 * server-side sigue siendo la única fuente de verdad.
 */
export function isAndreaniCreationBlockingCancellation(
  order: OrderForCancellationEligibility,
) {
  return (
    order.andreani_creation_status === "claimed" ||
    order.andreani_creation_status === "reconciliation_required"
  )
}

/**
 * Mismas 3 condiciones que ya bloquean approve_order_claim_cancellation /
 * admin_cancel_order (RPC, supabase/migrations/20260915120000_admin_direct_order_cancellation.sql)
 * -- server-side siempre queda la fuente de verdad, esto sólo evita mostrar
 * un botón que la RPC va a rechazar de todos modos.
 */
export function isOrderAlreadyCancelled(order: OrderForCancellationEligibility) {
  return (order.estado ?? "").toLowerCase() === "cancelado"
}

export function isOrderInvoicedForCancellation(order: OrderForCancellationEligibility) {
  return (
    order.invoice_status === "authorized" ||
    order.invoice_status === "processing" ||
    Boolean(order.invoice_cae) ||
    Boolean(order.invoice_number && order.invoice_point)
  )
}

export function isOrderDispatchedForCancellation(order: OrderForCancellationEligibility) {
  const estado = (order.estado ?? "").toLowerCase()
  const andreaniEstado = (order.andreani_estado ?? "").toLowerCase()

  return (
    DISPATCHED_ORDER_STATUSES.includes(estado) ||
    Boolean(
      (order.tracking_number ?? "").trim() ||
        (order.andreani_tracking ?? "").trim() ||
        (order.andreani_envio_id ?? "").trim(),
    ) ||
    DISPATCHED_ANDREANI_FRAGMENTS.some((fragment) => andreaniEstado.includes(fragment))
  )
}

function isSafeToCancelOrReject(order: OrderForCancellationEligibility) {
  return (
    !isOrderAlreadyCancelled(order) &&
    !isOrderInvoicedForCancellation(order) &&
    !isOrderDispatchedForCancellation(order) &&
    !isAndreaniCreationBlockingCancellation(order)
  )
}

/** Rechazar: sólo para pedidos que nunca llegaron a tener pago confirmado. */
export function canRejectOrder(order: OrderForCancellationEligibility) {
  return isSafeToCancelOrReject(order) && !isOrderPaymentConfirmed(order)
}

/** Cancelar: sólo para pedidos que sí tuvieron pago confirmado. */
export function canCancelOrder(order: OrderForCancellationEligibility) {
  return isSafeToCancelOrReject(order) && isOrderPaymentConfirmed(order)
}
