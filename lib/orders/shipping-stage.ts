/**
 * Etapas visibles del envío, iguales para Admin y para el cliente:
 * Preparando pedido → Listo para despachar → Despachado → En camino → Entregado.
 *
 * Sólo presentación: se derivan de estados que ya existen. "Despachado" es el
 * QR final del Bulto (BEYONIX entregó el paquete a Andreani); "En camino"
 * exige un estado real de transporte informado por Andreani y "Entregado",
 * la entrega final al cliente.
 */

export const SHIPPING_STAGES = ["preparing", "ready", "dispatched", "in_transit", "delivered"] as const
export type ShippingStage = (typeof SHIPPING_STAGES)[number]

export const SHIPPING_STAGE_LABELS: Record<ShippingStage, string> = {
  preparing: "Preparando pedido",
  ready: "Listo para despachar",
  dispatched: "Despachado",
  in_transit: "En camino",
  delivered: "Entregado",
}

/** Avance de Despachos ya calculado por el servidor (pickeo y QR final). */
export type DispatchProgress = "preparing" | "ready" | "dispatched"

export function getDispatchProgress(
  handedOverAt: string | null | undefined,
  packageStatus: "preparing" | "prepared" | string | null | undefined,
): DispatchProgress | null {
  if (handedOverAt?.trim()) return "dispatched"
  if (packageStatus === "prepared") return "ready"
  if (packageStatus === "preparing") return "preparing"
  return null
}

/** Estados de `ordenes.estado` que sólo fija un movimiento real de Andreani (o un Admin) después de salir. */
const IN_TRANSIT_ESTADOS = new Set([
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
])

const ANDREANI_TRANSPORT_TEXT = ["camino", "tránsito", "transito", "distribución", "distribucion", "reparto", "visita"]

/** Texto de estado de Andreani que ya describe transporte o reparto. */
export function isAndreaniTransportStatus(andreaniEstado: string | null | undefined) {
  const status = (andreaniEstado ?? "").toLowerCase()
  return ANDREANI_TRANSPORT_TEXT.some((text) => status.includes(text))
}

export interface ShippingStageOrder {
  estado?: string | null
  delivered_at?: string | null
  andreani_estado?: string | null
  /** Seguimiento cargado a mano (transporte distinto de Andreani). */
  tracking_number?: string | null
}

/**
 * Etapa visible del pedido; null mientras el pago no esté confirmado. El QR
 * final por sí solo nunca pasa de "Despachado".
 */
export function getShippingStage(
  order: ShippingStageOrder,
  { paymentConfirmed, dispatchProgress }: { paymentConfirmed: boolean; dispatchProgress: DispatchProgress | null | undefined },
): ShippingStage | null {
  const estado = (order.estado ?? "").toLowerCase()
  if (estado === "entregado" || order.delivered_at) return "delivered"
  if (IN_TRANSIT_ESTADOS.has(estado) || isAndreaniTransportStatus(order.andreani_estado)) return "in_transit"
  // `enviado`: Andreani admitió el paquete, todavía sin movimiento de transporte.
  if (estado === "enviado" || dispatchProgress === "dispatched" || order.tracking_number?.trim()) return "dispatched"
  if (!paymentConfirmed) return null
  // `preparado`: estado heredado que se fijaba a mano con el pedido ya armado.
  if (dispatchProgress === "ready" || estado === "preparado") return "ready"
  return "preparing"
}

export const shippingStageIndex = (stage: ShippingStage | null) => (stage ? SHIPPING_STAGES.indexOf(stage) : -1)
