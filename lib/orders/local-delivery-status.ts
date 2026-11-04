import { isLocalDeliveryOrder } from "../shipping/local-delivery.ts"
import { hasConfirmedPaymentEvidence } from "./order-payment-status.ts"

/**
 * Circuito operativo de Envío BEYONIX, separado del de Andreani (sin guía,
 * etiqueta ni Bulto general Andreani; usa el pickeo común y su propia
 * etiqueta por bulto): Preparando → En camino → Entregado.
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
 * Condiciones comunes a cualquier operación del circuito local (avance o
 * reintento de avisos): Envío BEYONIX, evidencia real de pago
 * (`hasConfirmedPaymentEvidence`, no sólo `financial_status`) y sin
 * cancelación ni reintegro. Las mismas condiciones se repiten en el WHERE de
 * cada escritura/autorización en base (`whereLocalDeliveryEligible` en
 * app/api/admin/dispatch/local/route.ts).
 */
function getLocalDeliveryEligibilityError(order: LocalDeliveryOrderState, cancelledMessage: string) {
  if (!isLocalDeliveryOrder(order)) return "Este pedido no usa Envío BEYONIX."
  if (order.estado === "cancelado" || order.cancelled_at || BLOCKING_FINANCIAL_STATUSES.includes(order.financial_status ?? "")) {
    return cancelledMessage
  }
  if (!hasConfirmedPaymentEvidence(order)) {
    return "El pedido no tiene el pago confirmado."
  }
  return null
}

/**
 * `null` si la transición es válida; si no, el motivo (texto para Admin).
 * Secuencia estricta: Preparando → En camino → Entregado. El pago tiene que
 * seguir confirmado (`financial_status = payment_confirmed`), sin cancelación
 * ni reintegro en curso; la misma condición se repite en el UPDATE atómico.
 */
export function getLocalDeliveryTransitionError(order: LocalDeliveryOrderState, action: LocalDeliveryAction) {
  const eligibilityError = getLocalDeliveryEligibilityError(order, "Pedido cancelado o con reintegro en curso: no puede avanzar en la entrega.")
  if (eligibilityError) return eligibilityError
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

/**
 * `null` si se pueden reintentar los avisos de la etapa actual. Se evalúa
 * sobre el pedido recién leído: un pedido cancelado, con reintegro pendiente
 * o hecho, sin pago confirmado o de otro proveedor nunca recibe avisos.
 */
export function getLocalDeliveryRetryError(order: LocalDeliveryOrderState) {
  const eligibilityError = getLocalDeliveryEligibilityError(order, "Pedido cancelado o con reintegro en curso: no se envían avisos de entrega.")
  if (eligibilityError) return eligibilityError
  if (getLocalDeliveryStage(order) === "preparing") return "Este pedido no tiene avisos de entrega para reintentar."
  return null
}

// La ruta genérica de estado sólo puede llevar un pedido local a estados
// previos al circuito de entrega, y nunca sacarlo de En camino/Entregado.
const GENERIC_STATUS_ALLOWED_FOR_LOCAL_DELIVERY = ["pendiente", "pagado"]
const LOCAL_DELIVERY_CIRCUIT_ESTADOS = ["en_camino", "entregado"]

/**
 * Cierra el bypass de `app/api/admin/pedidos/[id]/status`: para Envío
 * BEYONIX el avance existe sólo en `advanceLocalDelivery` (Despachos →
 * Entregas locales), sin importar el rol, ni siquiera super_admin.
 */
export function getGenericStatusChangeLocalDeliveryError(
  order: Pick<LocalDeliveryOrderState, "estado" | "shipping_provider" | "envio_proveedor">,
  nextEstado: string,
) {
  if (!isLocalDeliveryOrder(order)) return null
  if (
    GENERIC_STATUS_ALLOWED_FOR_LOCAL_DELIVERY.includes(nextEstado) &&
    !LOCAL_DELIVERY_CIRCUIT_ESTADOS.includes(order.estado ?? "")
  ) {
    return null
  }
  return "Los pedidos con Envío BEYONIX avanzan sólo desde Despachos → Entregas locales (Preparando → En camino → Entregado)."
}

/** Preparación física del pedido local (pickeo + bultos BX-PKG del intento vigente). */
export interface LocalDeliveryPreparation {
  packageStatus: "preparing" | "prepared" | null
  parcelCount: number | null
  confirmedParcels: number
}

/**
 * `null` si el pedido está listo para entregarse al cadete: pickeo completo,
 * bultos definidos y la etiqueta Envío BEYONIX de cada bulto confirmada
 * (escaneada). Misma regla que local_delivery_parcels_ready en la base, que
 * la vuelve a exigir al pasar a En camino.
 */
export function getLocalDeliveryPreparationError(preparation: LocalDeliveryPreparation) {
  if (!preparation.packageStatus) return "Prepará el pedido en Despachos: pickeo, bultos y etiquetas."
  if (preparation.packageStatus !== "prepared") return "Completá el pickeo del pedido en Despachos."
  if (!preparation.parcelCount) return "Definí los bultos del pedido en Despachos."
  const missing = preparation.parcelCount - preparation.confirmedParcels
  if (missing > 0) return missing === 1 ? "Falta confirmar 1 etiqueta BEYONIX." : `Faltan confirmar ${missing} etiquetas BEYONIX.`
  return null
}
