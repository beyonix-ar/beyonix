import "server-only"

import type { LocalDeliveryAdminClient } from "@/lib/orders/local-delivery-deps"
import { LOCAL_DELIVERY_IN_TRANSIT_MARKED_ACTION, LOCAL_DELIVERY_IN_TRANSIT_REVERTED_ACTION } from "@/lib/orders/local-delivery-service"
import { isLocalDeliveryOrder } from "@/lib/shipping/local-delivery"
import {
  isLocalDeliveryIncidentReason,
  isLocalDeliveryOutcomeStatus,
  isLocalDeliveryReservationStatus,
  type AdminLocalDeliveryOutcome,
  type AdminLocalDeliveryReservation,
  type CustomerLocalDeliveryOutcome,
  type LocalDeliveryOutcomeStatus,
  type LocalDeliveryReturnParcel,
} from "@/lib/shipping/local-delivery-outcome"

/**
 * Lectura del resultado de la entrega local (QR del cadete, retorno y
 * reserva) para Admin y para Mis compras. Una consulta por tabla para todos
 * los pedidos pedidos (sin N+1). Las tablas sólo las lee service_role.
 */

/** Resultados de la entrega registrados por el cadete o por Admin sobre una incidencia (misma lista que local_delivery_revert_blockers). */
const LOCAL_DELIVERY_COURIER_OUTCOME_ACTIONS = [
  "local_delivery_incident_reported", "local_delivery_attempt_failed", "local_delivery_incident_resolved", "local_delivery_return_started",
] as const

interface ShipmentRow {
  id: number
  order_id: number
  shipment_number: number
  outcome_status: string
  failed_attempts: number
  first_attempt_failed_at: string | null
  second_attempt_failed_at: string | null
  incident_reason: string | null
  incident_comment: string | null
  incident_at: string | null
  returning_at: string | null
  returned_at: string | null
}

interface ReservationRow {
  shipment_id: number
  status: string
  reservation_days: number
  expires_at: string
}

const SHIPMENT_COLUMNS =
  "id,order_id,shipment_number,outcome_status,failed_attempts,first_attempt_failed_at,second_attempt_failed_at,incident_reason,incident_comment,incident_at,returning_at,returned_at"

async function loadCurrentShipments(admin: LocalDeliveryAdminClient, orderIds: number[]) {
  const current = new Map<number, ShipmentRow>()
  if (!orderIds.length) return current
  const { data, error } = await admin.from("local_delivery_shipments").select(SHIPMENT_COLUMNS).in("order_id", orderIds)
  if (error) throw new Error("LOCAL_DELIVERY_OUTCOME_READ_FAILED")
  for (const row of (data ?? []) as ShipmentRow[]) {
    const previous = current.get(row.order_id)
    if (!previous || row.shipment_number > previous.shipment_number) current.set(row.order_id, row)
  }
  return current
}

async function loadReservations(admin: LocalDeliveryAdminClient, shipmentIds: number[]) {
  const byShipment = new Map<number, ReservationRow>()
  if (!shipmentIds.length) return byShipment
  const { data, error } = await admin.from("local_delivery_return_reservations")
    .select("shipment_id,status,reservation_days,expires_at").in("shipment_id", shipmentIds)
  if (error) throw new Error("LOCAL_DELIVERY_OUTCOME_READ_FAILED")
  for (const row of (data ?? []) as ReservationRow[]) byShipment.set(row.shipment_id, row)
  return byShipment
}

/** Bultos del intento vigente y cuáles volvieron (picking inverso). */
async function loadReturnParcels(admin: LocalDeliveryAdminClient, shipments: ShipmentRow[]) {
  const byOrder = new Map<number, LocalDeliveryReturnParcel[]>()
  if (!shipments.length) return byOrder
  const orderIds = shipments.map((row) => row.order_id)
  const [packages, receipts] = await Promise.all([
    admin.from("order_packages").select("id,order_id,attempt_number,parcel_count").in("order_id", orderIds),
    admin.from("local_delivery_return_receipts").select("shipment_id,parcel_id").in("shipment_id", shipments.map((row) => row.id)),
  ])
  if (packages.error || receipts.error) throw new Error("LOCAL_DELIVERY_OUTCOME_READ_FAILED")
  const packageRows = (packages.data ?? []) as Array<{ id: number; order_id: number; attempt_number: number; parcel_count: number | null }>
  const defined = packageRows.filter((row) => row.parcel_count)
  if (!defined.length) return byOrder
  const parcels = await admin.from("order_package_parcels").select("id,package_id,barcode,parcel_index,attempt_number,parcel_count")
    .in("package_id", defined.map((row) => row.id))
  if (parcels.error) throw new Error("LOCAL_DELIVERY_OUTCOME_READ_FAILED")
  const received = new Set(((receipts.data ?? []) as Array<{ parcel_id: number }>).map((row) => row.parcel_id))
  const packageById = new Map(defined.map((row) => [row.id, row]))
  for (const parcel of (parcels.data ?? []) as Array<{ id: number; package_id: number; barcode: string; parcel_index: number; attempt_number: number; parcel_count: number }>) {
    const pkg = packageById.get(parcel.package_id)
    if (!pkg || parcel.attempt_number !== pkg.attempt_number || parcel.parcel_count !== pkg.parcel_count) continue
    byOrder.set(pkg.order_id, [...(byOrder.get(pkg.order_id) ?? []), { barcode: parcel.barcode, index: parcel.parcel_index, received: received.has(parcel.id) }])
  }
  for (const list of byOrder.values()) list.sort((left, right) => left.index - right.index)
  return byOrder
}

function toAdminReservation(row: ReservationRow | undefined): AdminLocalDeliveryReservation | null {
  if (!row || !isLocalDeliveryReservationStatus(row.status)) return null
  return { status: row.status, reservationDays: row.reservation_days, expiresAt: row.expires_at }
}

/** Resultado de la entrega local por pedido (sólo los que tienen QR emitido). Lanza si no se pudo leer. */
export async function loadAdminLocalDeliveryOutcomes(admin: LocalDeliveryAdminClient, orderIds: number[]) {
  const outcomes = new Map<number, AdminLocalDeliveryOutcome>()
  const shipments = [...(await loadCurrentShipments(admin, orderIds)).values()]
    .filter((row) => isLocalDeliveryOutcomeStatus(row.outcome_status))
  const returning = shipments.filter((row) => row.outcome_status === "returning" || row.outcome_status === "returned")
  const [reservations, parcels] = await Promise.all([
    loadReservations(admin, returning.map((row) => row.id)),
    loadReturnParcels(admin, returning),
  ])
  for (const row of shipments) {
    const status = row.outcome_status as LocalDeliveryOutcomeStatus
    outcomes.set(row.order_id, {
      status,
      failedAttempts: row.failed_attempts,
      firstAttemptFailedAt: row.first_attempt_failed_at,
      secondAttemptFailedAt: row.second_attempt_failed_at,
      incident: status === "incident" && isLocalDeliveryIncidentReason(row.incident_reason)
        ? { reason: row.incident_reason, comment: row.incident_comment, at: row.incident_at }
        : null,
      returningAt: row.returning_at,
      returnedAt: row.returned_at,
      reservation: toAdminReservation(reservations.get(row.id)),
      returnParcels: status === "returning" || status === "returned" ? parcels.get(row.order_id) ?? [] : null,
    })
  }
  return outcomes
}

type ProviderOrder = { id: number; shipping_provider?: string | null; envio_proveedor?: string | null }

/**
 * Resumen del resultado local por pedido Envío BEYONIX (estado, intentos y
 * reserva): nunca motivos, comentarios del cadete, días configurados ni datos
 * internos. Lo usan Mis compras y la presentación de Admin → Pedidos. Lanza si
 * no se pudo leer.
 */
export async function loadLocalDeliveryOutcomeSummaries(admin: LocalDeliveryAdminClient, orders: ProviderOrder[]) {
  const summaries = new Map<number, CustomerLocalDeliveryOutcome>()
  const localIds = orders.filter((order) => isLocalDeliveryOrder(order)).map((order) => order.id)
  if (!localIds.length) return summaries
  const shipments = await loadCurrentShipments(admin, localIds)
  const reservations = await loadReservations(admin, [...shipments.values()]
    .filter((row) => row.outcome_status === "returned").map((row) => row.id))
  for (const [orderId, row] of shipments) {
    if (!isLocalDeliveryOutcomeStatus(row.outcome_status)) continue
    const reservation = reservations.get(row.id)
    summaries.set(orderId, {
      status: row.outcome_status,
      failedAttempts: row.failed_attempts,
      reservation: reservation && isLocalDeliveryReservationStatus(reservation.status)
        ? { status: reservation.status, expiresAt: reservation.expires_at }
        : null,
    })
  }
  return summaries
}

/**
 * Salida vigente con el cadete de cada pedido: el registro atómico de
 * mark_local_delivery_in_transit posterior a la última corrección de
 * "Entregado al cadete" (por id: orden real de escritura). El registro
 * 'order_status_changed' del servicio no sirve: puede escribirse más tarde
 * en un reintento. Sin registro vigente, o si después el cadete o Admin
 * registraron algo (intento fallido, incidencia —aunque se reintente—,
 * regreso), el pedido no aparece: no se promete nada. Lanza si no se pudo leer.
 */
export async function loadLocalDeliveryInTransitAt(admin: LocalDeliveryAdminClient, orderIds: number[]) {
  const inTransitAt = new Map<number, string>()
  if (!orderIds.length) return inTransitAt
  const { data, error } = await admin.from("order_audit_events").select("id,order_id,action,created_at")
    .in("order_id", orderIds).in("action", [LOCAL_DELIVERY_IN_TRANSIT_MARKED_ACTION, LOCAL_DELIVERY_IN_TRANSIT_REVERTED_ACTION, ...LOCAL_DELIVERY_COURIER_OUTCOME_ACTIONS])
  if (error) throw new Error("LOCAL_DELIVERY_OUTCOME_READ_FAILED")
  const latest = new Map<number, { id: number; action: string; created_at: string }>()
  for (const row of (data ?? []) as Array<{ id: number; order_id: number; action: string; created_at: string }>) {
    const previous = latest.get(row.order_id)
    if (!previous || row.id > previous.id) latest.set(row.order_id, row)
  }
  // El último evento manda: una salida sólo promete si nada la siguió.
  for (const [orderId, row] of latest) {
    if (row.action === LOCAL_DELIVERY_IN_TRANSIT_MARKED_ACTION && Number.isFinite(Date.parse(row.created_at))) inTransitAt.set(orderId, row.created_at)
  }
  return inTransitAt
}

/**
 * Corrección de "Entregado al cadete" disponible por pedido, con la misma regla
 * que aplica la base al ejecutarla (local_delivery_revert_blockers). Si no se
 * pudo leer, ninguno queda disponible (nunca se ofrece algo que se rechazaría).
 */
export async function loadLocalDeliveryRevertable(admin: LocalDeliveryAdminClient, orderIds: number[]) {
  const revertable = new Set<number>()
  if (!orderIds.length) return revertable
  const { data, error } = await admin.rpc("local_delivery_revert_blockers", { p_order_ids: orderIds })
  if (error || !Array.isArray(data)) return revertable
  for (const row of data as Array<{ order_id: unknown; blocker: unknown }>) {
    const id = Number(row.order_id)
    if (Number.isSafeInteger(id) && row.blocker === null) revertable.add(id)
  }
  return revertable
}

/** Mis compras: agrega `local_delivery_outcome` a los pedidos Envío BEYONIX. Lanza si no se pudo leer. */
export async function attachCustomerLocalDeliveryOutcomes<T extends ProviderOrder & { estado?: string | null }>(
  admin: LocalDeliveryAdminClient,
  orders: T[],
): Promise<Array<T & { local_delivery_outcome?: CustomerLocalDeliveryOutcome | null }>> {
  const summaries = await loadLocalDeliveryOutcomeSummaries(admin, orders)
  if (!summaries.size) return orders
  // "¡Llega hoy!": sólo hace falta para los que siguen En camino sin resultado del cadete.
  const inTransitAt = await loadLocalDeliveryInTransitAt(admin, orders
    .filter((order) => order.estado === "en_camino" && summaries.get(order.id)?.status === "pending")
    .map((order) => order.id))
  return orders.map((order) => {
    const summary = summaries.get(order.id)
    return summary ? { ...order, local_delivery_outcome: { ...summary, inTransitAt: inTransitAt.get(order.id) ?? null } } : order
  })
}
