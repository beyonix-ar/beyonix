/**
 * Presentación de los envíos Andreani de un reclamo (order_claim_shipments):
 * devolución (cliente -> BEYONIX) y reemplazo (BEYONIX -> cliente), para el
 * cliente y para Admin. Pura. El cliente nunca recibe costo, contrato,
 * ambiente ni errores internos.
 */

export type ClaimShipmentDirection = "devolucion" | "reemplazo"
export type ClaimShipmentStatus = "pendiente" | "generada" | "en_transito" | "entregada" | "incidencia"
export type ClaimShipmentModality = "retiro_domicilio" | "despacho_sucursal" | "entrega_domicilio" | "entrega_sucursal"

export interface ClaimShipmentViewSource {
  direction: ClaimShipmentDirection
  status: ClaimShipmentStatus
  modality?: ClaimShipmentModality | null
  andreani_tracking?: string | null
  /** Sólo Admin: el cliente recibe label_available en su lugar. */
  creation_status?: string | null
  creation_error?: string | null
  cost_amount?: number | string | null
  andreani_estado?: string | null
  delivered_at?: string | null
}

export const CLAIM_RETURN_PACKING_INSTRUCTIONS =
  "Prepará el producto completo, con caja, bolsas, manuales, accesorios y todos los elementos recibidos, correctamente embalado y en el mejor estado posible."

const STATUS_LABELS: Record<ClaimShipmentDirection, Record<ClaimShipmentStatus, string>> = {
  devolucion: {
    pendiente: "Devolución pendiente",
    generada: "Retiro/despacho generado",
    en_transito: "En tránsito hacia BEYONIX",
    entregada: "Recibido por BEYONIX",
    incidencia: "Incidencia en la devolución",
  },
  reemplazo: {
    pendiente: "Preparando el envío del reemplazo",
    generada: "Reemplazo despachado",
    en_transito: "Reemplazo en camino",
    entregada: "Reemplazo entregado",
    incidencia: "Incidencia en el envío del reemplazo",
  },
}

const CUSTOMER_MODALITY_LABELS: Record<ClaimShipmentModality, string> = {
  retiro_domicilio: "Andreani retira el producto en tu domicilio",
  despacho_sucursal: "Despachás el producto en una sucursal Andreani",
  entrega_domicilio: "Entrega en el domicilio de tu compra",
  entrega_sucursal: "Retiro en la sucursal Andreani que elegiste en tu compra",
}

const ADMIN_MODALITY_LABELS: Record<ClaimShipmentModality, string> = {
  retiro_domicilio: "Retiro Andreani en el domicilio del cliente",
  despacho_sucursal: "El cliente despacha en una sucursal Andreani",
  entrega_domicilio: "Entrega Andreani a domicilio (contrato de venta domicilio)",
  entrega_sucursal: "Entrega Andreani en sucursal (contrato de venta sucursal)",
}

const ACCEPTED_CHANGE_STATUSES = ["aprobado", "cambio_pendiente"]

/**
 * ¿Este guardado del Admin es el que aceptó el cambio? (tocó status o
 * resolución y el reclamo quedó con cambio de producto aceptado). Un mensaje
 * posterior sobre un cambio ya aceptado no vuelve a disparar la devolución.
 */
export function isClaimChangeAcceptance(
  patch: { status?: unknown; resolution?: unknown },
  claim: { status?: string | null; resolution?: string | null },
) {
  const touchedDecision = patch.status !== undefined || patch.resolution !== undefined
  return touchedDecision && claim.resolution === "cambio_producto" && ACCEPTED_CHANGE_STATUSES.includes(String(claim.status))
}

/** Tramo del embed (arreglo u objeto) de order_claim_shipments. */
export function pickClaimShipment<T extends { direction: ClaimShipmentDirection }>(
  value: T | T[] | null | undefined,
  direction: ClaimShipmentDirection,
): T | null {
  const rows = Array.isArray(value) ? value : value ? [value] : []
  return rows.find((row) => row.direction === direction) ?? null
}

/** Etiqueta disponible = la orden Andreani existe (estado distinto de pendiente). */
function hasAndreaniOrder(source: ClaimShipmentViewSource) {
  return source.status !== "pendiente"
}

export function getCustomerClaimShipmentView(source: ClaimShipmentViewSource | null | undefined) {
  if (!source) return null
  const tracking = source.andreani_tracking?.trim() || null
  const instructions: string[] = []
  let label: { required: boolean } | null = null

  if (source.direction === "devolucion") {
    if (source.status === "entregada") {
      instructions.push("Recibimos tu producto. Lo estamos revisando y te avisaremos cómo sigue el cambio.")
    } else {
      instructions.push(CLAIM_RETURN_PACKING_INSTRUCTIONS)
      if (source.status === "pendiente") {
        instructions.push("Estamos coordinando la devolución con Andreani. Te vamos a avisar por este medio cómo enviarlo.")
      } else if (source.modality === "retiro_domicilio") {
        instructions.push("Andreani va a pasar a retirarlo por el domicilio de entrega de tu compra. Tené el paquete listo y cerrado.")
        label = { required: false }
      } else if (source.modality === "despacho_sucursal") {
        instructions.push("Descargá e imprimí la etiqueta de devolución, pegala en el paquete cerrado y llevalo a una sucursal Andreani.")
        label = { required: true }
      }
    }
  } else if (source.status === "pendiente") {
    instructions.push("Estamos preparando el envío de tu producto de reemplazo.")
  } else if (source.status === "entregada") {
    instructions.push("Andreani informó que tu producto de reemplazo fue entregado.")
  } else if (source.modality === "entrega_sucursal") {
    instructions.push("Andreani te avisa cuando esté disponible en la sucursal. Llevá tu DNI para retirarlo.")
  } else {
    instructions.push("Andreani lo entrega en el domicilio de tu compra. Si no hay nadie, deja un aviso para coordinar.")
  }
  if (source.status === "incidencia") {
    instructions.push("Andreani informó una novedad con el envío. Si necesitás ayuda, escribinos por este medio.")
  }

  return {
    direction: source.direction,
    title: source.direction === "devolucion" ? "Devolución del producto" : "Envío del reemplazo",
    statusLabel: STATUS_LABELS[source.direction][source.status],
    modalityLabel: source.modality ? CUSTOMER_MODALITY_LABELS[source.modality] : null,
    tracking,
    instructions,
    // Sólo el cliente descarga la etiqueta de SU devolución; nunca la del reemplazo.
    label: label && hasAndreaniOrder(source) ? label : null,
  }
}

export function getAdminClaimShipmentView(source: ClaimShipmentViewSource | null | undefined, direction: ClaimShipmentDirection) {
  const creation = source?.creation_status ?? "not_started"
  const status = source?.status ?? "pendiente"
  const cost = source?.cost_amount == null || source.cost_amount === "" ? null : Number(source.cost_amount)
  const created = creation === "created"
  return {
    direction,
    title: direction === "devolucion" ? "Devolución" : "Reemplazo",
    exists: Boolean(source),
    statusLabel: STATUS_LABELS[direction][status],
    modalityLabel: source?.modality ? ADMIN_MODALITY_LABELS[source.modality] : null,
    tracking: source?.andreani_tracking?.trim() || null,
    andreaniEstado: source?.andreani_estado?.trim() || null,
    costLabel: cost != null && Number.isFinite(cost) ? `$ ${cost.toLocaleString("es-AR")}` : "No informado por Andreani",
    error: created ? null : source?.creation_error?.trim() || null,
    manualReview: creation === "manual_review",
    canCreate: status === "pendiente" && (creation === "not_started" || creation === "failed"),
    canSync: created && status !== "entregada",
    canReconcile: creation === "manual_review",
    labelAvailable: created,
    delivered: status === "entregada",
  }
}
