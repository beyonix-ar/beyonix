import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import { appendOrderAuditEvent, type OrderAuditActorType } from "../orders/order-audit.ts"
import { sendOrderStateEmail } from "../orders/order-status-notifications.ts"
import { activatePendingItemWarranties } from "../orders/warranty-activation.ts"

import {
  AndreaniError,
  getEstadoOrden,
  getTrackingPullV3,
  type AndreaniClientOptions,
} from "./client.ts"
import {
  collectAndreaniTrackingHistoryEvents,
  logUnrecognizedAndreaniEvents,
  recordAndreaniTrackingHistory,
  type AndreaniTrackingHistoryEvent,
} from "./tracking-history.ts"
import { parseAndreaniTimestamp } from "./tracking-timestamps.ts"
import {
  mapAndreaniEventToOrderMilestone,
  resolveAndreaniAutoOrderTransition,
  type AndreaniAutoOrderTransition,
} from "./tracking-status-mapping.ts"
import type {
  AndreaniEnvironment,
  AndreaniTrackingEvent,
  AndreaniUnrecognizedTrackingEvent,
} from "./types.ts"
import { isAndreaniPreShipmentRejected } from "./types.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export interface AndreaniOrderTrackingRow {
  id: number
  estado: string
  delivered_at: string | null
  andreani_envio_id: string | null
  andreani_tracking: string | null
  andreani_creation_environment: AndreaniEnvironment | null
  /** "sucursal" | "domicilio": decide si la llegada a sucursal es "en_sucursal" o tránsito. */
  shipping_type: string | null
  cliente_email: string | null
  cliente_nombre: string | null
  tracking_number: string | null
  tracking_url: string | null
}

/** Columnas que necesita `syncAndreaniOrderTracking` (cron y botón "Consultar"). */
export const ANDREANI_ORDER_TRACKING_SELECT =
  "id, estado, delivered_at, andreani_tracking, andreani_envio_id, andreani_creation_environment, shipping_type, cliente_email, cliente_nombre, tracking_number, tracking_url"

export interface AndreaniOrderTrackingSnapshot {
  logisticsEstado: string
  resolvedTracking: string
  etiquetaUrl: string | null
  eventos: AndreaniTrackingEvent[]
  /** Eventos fuera del maestro: se registran y piden revisión, nunca mueven estados. */
  eventosNoReconocidos: AndreaniUnrecognizedTrackingEvent[]
  latestEvent: AndreaniTrackingEvent | null
  rejectedAfterCreation: boolean
}

/**
 * El tracking se consulta contra el mismo ambiente donde se creó el envío
 * (persistido al crear), nunca contra el ambiente configurado hoy -- un
 * pedido creado en PROD sigue siendo un pedido PROD aunque la tienda pase a
 * operar en QA después.
 */
export function resolveAndreaniTrackingEnvironment(
  order: Pick<AndreaniOrderTrackingRow, "andreani_creation_environment">,
): AndreaniEnvironment {
  return order.andreani_creation_environment === "PROD" ? "PROD" : "QA"
}

/**
 * Consulta real (sólo GET, sin ningún efecto secundario en Andreani) del
 * estado y tracking de un envío ya creado. Única función que arma este
 * snapshot -- la usan tanto el botón "Consultar" (admin, on-demand) como la
 * sincronización automática (cron): mismo criterio, mismo mapping, una sola
 * llamada a Andreani por consulta, nunca dos implementaciones distintas.
 */
export async function fetchAndreaniOrderTrackingSnapshot(
  order: Pick<
    AndreaniOrderTrackingRow,
    "andreani_envio_id" | "andreani_tracking" | "andreani_creation_environment"
  >,
  clientOptionsOverride?: AndreaniClientOptions,
): Promise<AndreaniOrderTrackingSnapshot> {
  const envioId = (order.andreani_envio_id ?? "").trim()
  if (!envioId) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "El pedido todavía no tiene un envío Andreani generado.",
    )
  }

  const environment = resolveAndreaniTrackingEnvironment(order)
  const clientOptions: AndreaniClientOptions = clientOptionsOverride ?? {
    env: { ...process.env, ANDREANI_ENV: environment },
    productionAccess: environment === "PROD" ? "shipment-read" : undefined,
  }

  const numeroDeTrackingConocido = (order.andreani_tracking ?? "").trim()
  // Se consulta siempre, incluso con tracking ya conocido: es la única
  // forma de detectar que Andreani rechazó la orden después de haberla
  // creado (estado "Rechazado"/"Rechazada"), algo que /v3/trazas no informa.
  const orderStatus = await getEstadoOrden(envioId, clientOptions)
  const resolvedTracking =
    numeroDeTrackingConocido || orderStatus.bultos[0]?.numeroDeEnvio || ""
  const tracking = resolvedTracking
    ? await getTrackingPullV3(resolvedTracking, clientOptions)
    : { eventos: [], eventosNoReconocidos: [] }

  // Fechas con y sin offset pueden convivir: comparar instantes absolutos.
  const sortedEvents = [...tracking.eventos].sort(
    (left, right) => Date.parse(parseAndreaniTimestamp(right.Fecha)) - Date.parse(parseAndreaniTimestamp(left.Fecha)),
  )
  const [latestEvent] = sortedEvents
  // Algunos eventos (p. ej. "OrdenDeEnvioCreada") no traen un Estado
  // legible en /v3/trazas -- el estado logístico mostrado al admin debe
  // reflejar el evento más reciente que sí lo tenga, no el técnicamente
  // más reciente sin más (si no, se pisa un estado real como "Pendiente
  // de ingreso" con un código interno como "OrdenDeEnvioCreada").
  const latestEventWithEstado = sortedEvents.find((event) => event.Estado)
  const rejectedAfterCreation = isAndreaniPreShipmentRejected(orderStatus.estado)
  const logisticsEstado = rejectedAfterCreation
    ? orderStatus.estado
    : (latestEventWithEstado?.Estado ?? orderStatus.estado)

  const etiquetaUrl =
    orderStatus.etiquetasPorAgrupador ??
    orderStatus.bultos[0]?.linking?.find((link) =>
      link.meta.toLowerCase().includes("etiqueta"),
    )?.contenido ??
    null

  return {
    logisticsEstado,
    resolvedTracking,
    etiquetaUrl,
    eventos: tracking.eventos,
    eventosNoReconocidos: tracking.eventosNoReconocidos,
    latestEvent: latestEvent ?? null,
    rejectedAfterCreation,
  }
}

export interface AndreaniOrderTrackingSyncResult {
  snapshot: AndreaniOrderTrackingSnapshot
  checkedAt: string
  /** true sólo si `ordenes.estado` efectivamente cambió como consecuencia de esta consulta. */
  statusChanged: boolean
  newEstado: AndreaniAutoOrderTransition | null
  /** Eventos que esta consulta agregó al historial (vacío si ya estaban). */
  newHistoryEvents: AndreaniTrackingHistoryEvent[]
}

/**
 * Consulta Andreani, persiste tracking/estado/timestamps y -- con evidencia
 * suficiente (ver `resolveAndreaniAutoOrderTransition`) -- avanza
 * `ordenes.estado` reutilizando exactamente los mismos efectos secundarios
 * que el cambio manual de estado (activar garantía, auditoría, email):
 * nunca una segunda copia de esa lógica. Usada tanto por el botón
 * "Consultar" (admin) como por la sincronización automática (cron).
 */
export async function syncAndreaniOrderTracking(
  admin: AdminClient,
  order: AndreaniOrderTrackingRow,
  options: {
    actorType: OrderAuditActorType
    actorId: string | null
    clientOptions?: AndreaniClientOptions
  },
): Promise<AndreaniOrderTrackingSyncResult> {
  const snapshot = await fetchAndreaniOrderTrackingSnapshot(order, options.clientOptions)
  const checkedAt = new Date().toISOString()

  const autoTransition = snapshot.rejectedAfterCreation
    ? null
    : resolveAndreaniAutoOrderTransition(snapshot.eventos, order.estado, order.shipping_type)
  const isRealTransition = Boolean(autoTransition && autoTransition !== order.estado)
  const eventAt = snapshot.latestEvent ? parseAndreaniTimestamp(snapshot.latestEvent.Fecha) : null

  const updatePayload: Record<string, unknown> = {
    andreani_estado: snapshot.logisticsEstado,
    andreani_tracking: snapshot.resolvedTracking || null,
    andreani_etiqueta_url: snapshot.etiquetaUrl,
    andreani_tracking_checked_at: checkedAt,
    ...(snapshot.latestEvent
      ? { andreani_tracking_event_at: eventAt }
      : {}),
    ...(isRealTransition ? { estado: autoTransition } : {}),
    ...(isRealTransition && autoTransition === "entregado" && !order.delivered_at
      ? { delivered_at: checkedAt }
      : {}),
  }

  let query = admin.from("ordenes").update(updatePayload as never)
    .eq("id", order.id).eq("estado", order.estado)
  // La comparación ocurre en el UPDATE: una respuesta atrasada no puede
  // reemplazar eventos más recientes persistidos por otro admin o el cron.
  query = eventAt
    ? query.or(`andreani_tracking_event_at.is.null,andreani_tracking_event_at.lte.${eventAt}`)
    : query.is("andreani_tracking_event_at", null)

  const { data, error } = await query
    .select("id, estado, delivered_at, cliente_email, cliente_nombre, tracking_number, tracking_url")
    .maybeSingle()

  if (error) {
    throw new AndreaniError(
      "REQUEST_FAILED",
      "Andreani respondió, pero no se pudo persistir el estado del envío.",
    )
  }

  const statusChanged = Boolean(isRealTransition && data && data.estado === autoTransition)

  if (statusChanged && data && autoTransition) {
    if (autoTransition === "entregado" && data.delivered_at) {
      await activatePendingItemWarranties(admin, {
        orderId: order.id,
        deliveredAt: data.delivered_at,
        actorType: options.actorType,
        actorId: options.actorId,
      })
    }

    await appendOrderAuditEvent(admin, {
      orderId: order.id,
      actorType: options.actorType,
      actorId: options.actorId,
      action: "andreani_tracking_auto_status_changed",
      previousStatus: order.estado,
      newStatus: autoTransition,
      metadata: {
        checkedAt,
        andreaniEstado: snapshot.logisticsEstado,
        eventos: snapshot.eventos.map((event) => event.Evento),
      },
    })

    await sendOrderStateEmail(data)
  }

  const historyScope = { orderId: order.id, tracking: snapshot.resolvedTracking }
  const historyEvents = collectAndreaniTrackingHistoryEvents(historyScope, snapshot)
  // La transición se atribuye al primer evento (cronológico) que prueba el
  // hito alcanzado: el resto de los eventos queda sin cambio de estado.
  const milestoneCodes = new Set<string>(
    snapshot.eventos
      .filter((event) => mapAndreaniEventToOrderMilestone(event.Evento, order.shipping_type) === autoTransition)
      .map((event) => event.Evento),
  )
  const drivingEvent = statusChanged
    ? historyEvents.find((event) => event.recognized && milestoneCodes.has(event.code))
    : undefined
  const newHistoryEvents = await recordAndreaniTrackingHistory(
    admin,
    historyScope,
    historyEvents,
    drivingEvent && autoTransition
      ? { dedupeKey: drivingEvent.dedupeKey, previousStatus: order.estado, newStatus: autoTransition }
      : null,
  )
  await flagUnrecognizedOrderTrackingEvents(admin, order.id, historyScope, newHistoryEvents, options)

  return {
    snapshot,
    checkedAt,
    statusChanged,
    newEstado: statusChanged ? autoTransition : null,
    newHistoryEvents,
  }
}

/**
 * Evento que BEYONIX no sabe interpretar: no cambia `ordenes.estado` (el
 * resto del tracking sigue aplicándose), queda crudo en el historial, en un
 * log estructurado y en la auditoría del pedido, y el pedido se marca para
 * revisión (`andreani_tracking_review_*`, sólo el primero: nunca se pisa).
 * Se ejecuta una sola vez por evento: sólo para los recién registrados.
 */
async function flagUnrecognizedOrderTrackingEvents(
  admin: AdminClient,
  orderId: number,
  scope: { orderId: number; tracking: string },
  newHistoryEvents: readonly AndreaniTrackingHistoryEvent[],
  options: { actorType: OrderAuditActorType; actorId: string | null },
) {
  const unrecognized = newHistoryEvents.filter((event) => !event.recognized)
  if (unrecognized.length === 0) return
  logUnrecognizedAndreaniEvents(scope, unrecognized)

  const [first] = unrecognized
  const { error } = await admin
    .from("ordenes")
    .update({
      andreani_tracking_review_event: [first.code, first.text].filter(Boolean).join(" · ").slice(0, 300),
      andreani_tracking_review_at: new Date().toISOString(),
    } as never)
    .eq("id", orderId)
    .is("andreani_tracking_review_event", null)
  if (error) {
    console.error("ANDREANI_TRACKING_REVIEW_FLAG_ERROR", { orderId, message: error.message })
  }

  for (const event of unrecognized) {
    await appendOrderAuditEvent(admin, {
      orderId,
      actorType: options.actorType,
      actorId: options.actorId,
      action: "andreani_tracking_unknown_event",
      metadata: {
        tracking: scope.tracking,
        eventCode: event.code,
        eventText: event.text,
        eventCycle: event.cycle,
        eventAt: event.at,
        details: event.details,
      },
    })
  }
}
