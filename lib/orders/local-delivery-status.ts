import { isLocalDeliveryOrder } from "../shipping/local-delivery.ts"
import { isOrderPaymentConfirmed } from "./order-payment-status.ts"

/**
 * Circuito operativo de Envío BEYONIX, separado del de Andreani (sin etiqueta,
 * guía ni Bulto): Preparando → En camino → Entregado.
 *
 * Reutiliza estados existentes de `ordenes.estado`:
 * - Preparando = pago confirmado sin salir ("pagado"; "preparado" es el
 *   estado heredado del armado manual).
 * - En camino  = "en_camino".
 * - Entregado  = "entregado" (+ delivered_at).
 */
export type LocalDeliveryAction = "en_camino" | "entregado"
export type LocalDeliveryStage = "preparing" | "in_transit" | "delivered"

export const LOCAL_DELIVERY_STAGE_LABELS: Record<LocalDeliveryStage, string> = {
  preparing: "Preparando",
  in_transit: "En camino",
  delivered: "Entregado",
}

const PREPARING_ESTADOS = ["pagado", "preparado"]
const BLOCKING_FINANCIAL_STATUSES = ["cancelled", "cancellation_requested", "refund_pending", "refunded"]

export interface LocalDeliveryOrderState {
  estado: string | null
  shipping_provider?: string | null
  envio_proveedor?: string | null
  delivered_at?: string | null
  cancelled_at?: string | null
  financial_status?: string | null
  order_change_status?: string | null
  paid_at?: string | null
  payment_status?: string | null
  payment_confirmed_amount?: number | null
}

export function isLocalDeliveryAction(value: unknown): value is LocalDeliveryAction {
  return value === "en_camino" || value === "entregado"
}

export function getLocalDeliveryStage(order: Pick<LocalDeliveryOrderState, "estado" | "delivered_at">): LocalDeliveryStage {
  if (order.estado === "entregado" || order.delivered_at) return "delivered"
  if (order.estado === "en_camino") return "in_transit"
  return "preparing"
}

/** Siguiente (y único) avance posible desde cada etapa: sin saltos. */
export function getNextLocalDeliveryAction(stage: LocalDeliveryStage): LocalDeliveryAction | null {
  return stage === "preparing" ? "en_camino" : stage === "in_transit" ? "entregado" : null
}

/** Estado de `ordenes.estado` desde el que se permite cada avance. */
export function getLocalDeliveryActionSourceEstados(action: LocalDeliveryAction) {
  return action === "en_camino" ? PREPARING_ESTADOS : ["en_camino"]
}

/**
 * `null` si la transición es válida; si no, el motivo (texto para Admin).
 * Secuencia estricta: Preparando → En camino → Entregado. El pago tiene que
 * seguir confirmado (`financial_status = payment_confirmed`), sin cancelación
 * ni reintegro en curso; la misma condición se repite en el UPDATE atómico.
 */
export function getLocalDeliveryTransitionError(order: LocalDeliveryOrderState, action: LocalDeliveryAction) {
  if (!isLocalDeliveryOrder(order)) return "Este pedido no usa Envío BEYONIX."
  if (order.estado === "cancelado" || order.cancelled_at || BLOCKING_FINANCIAL_STATUSES.includes(order.financial_status ?? "")) {
    return "Pedido cancelado o con reintegro en curso: no puede avanzar en la entrega."
  }
  if (order.financial_status !== "payment_confirmed" || !isOrderPaymentConfirmed(order)) {
    return "El pedido no tiene el pago confirmado."
  }
  if (order.order_change_status === "change_requested" || order.order_change_status === "extra_payment_pending") {
    return "El pedido tiene un cambio pendiente: resolvelo antes de entregarlo."
  }
  const stage = getLocalDeliveryStage(order)
  if (stage === "delivered") return "El pedido ya figura como entregado."
  if (!getLocalDeliveryActionSourceEstados(action).includes(order.estado ?? "")) {
    return action === "en_camino"
      ? "Sólo un pedido en preparación puede salir en camino."
      : "Primero marcá el pedido como En camino."
  }
  return null
}
