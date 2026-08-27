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
import { parseAndreaniTimestamp } from "./tracking-timestamps.ts"
import { resolveAndreaniAutoOrderTransition } from "./tracking-status-mapping.ts"
import type { AndreaniEnvironment, AndreaniTrackingEvent } from "./types.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export interface AndreaniOrderTrackingRow {
  id: number
  estado: string
  delivered_at: string | null
  andreani_envio_id: string | null
  andreani_tracking: string | null
  andreani_creation_environment: AndreaniEnvironment | null
  cliente_email: string | null
  cliente_nombre: string | null
  tracking_number: string | null
  tracking_url: string | null
}

export interface AndreaniOrderTrackingSnapshot {
  logisticsEstado: string
  resolvedTracking: string
  etiquetaUrl: string | null
  eventos: AndreaniTrackingEvent[]
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
  // creado (estado "Rechazado"), algo que /v3/trazas no informa.
  const orderStatus = await getEstadoOrden(envioId, clientOptions)
  const resolvedTracking =
    numeroDeTrackingConocido || orderStatus.bultos[0]?.numeroDeEnvio || ""
  const tracking = resolvedTracking
    ? await getTrackingPullV3(resolvedTracking, clientOptions)
    : { eventos: [] }

  // Orden relativo entre eventos: comparar los strings de Fecha crudos (con
  // o sin offset) preserva el orden real porque el desplazamiento faltante
  // es el mismo para todos los eventos de esta respuesta -- sólo hace falta
  // convertir a un instante absoluto correcto al persistir, no para ordenar.
  const sortedEvents = [...tracking.eventos].sort(
    (left, right) => new Date(right.Fecha).getTime() - new Date(left.Fecha).getTime(),
  )
  const [latestEvent] = sortedEvents
  // Algunos eventos (p. ej. "OrdenDeEnvioCreada") no traen un Estado
  // legible en /v3/trazas -- el estado logístico mostrado al admin debe
  // reflejar el evento más reciente que sí lo tenga, no el técnicamente
  // más reciente sin más (si no, se pisa un estado real como "Pendiente
  // de ingreso" con un código interno como "OrdenDeEnvioCreada").
  const latestEventWithEstado = sortedEvents.find((event) => event.Estado)
  const rejectedAfterCreation = orderStatus.estado === "Rechazado"
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
    latestEvent: latestEvent ?? null,
    rejectedAfterCreation,
  }
}

export interface AndreaniOrderTrackingSyncResult {
  snapshot: AndreaniOrderTrackingSnapshot
  checkedAt: string
  /** true sólo si `ordenes.estado` efectivamente cambió como consecuencia de esta consulta. */
  statusChanged: boolean
  newEstado: "en_camino" | "entregado" | null
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

  const autoTransition = resolveAndreaniAutoOrderTransition(snapshot.eventos, order.estado)
  const isRealTransition = Boolean(autoTransition && autoTransition !== order.estado)

  const updatePayload: Record<string, unknown> = {
    andreani_estado: snapshot.logisticsEstado,
    andreani_tracking: snapshot.resolvedTracking || null,
    andreani_etiqueta_url: snapshot.etiquetaUrl,
    andreani_tracking_checked_at: checkedAt,
    ...(snapshot.latestEvent
      ? { andreani_tracking_event_at: parseAndreaniTimestamp(snapshot.latestEvent.Fecha) }
      : {}),
    ...(isRealTransition ? { estado: autoTransition } : {}),
    ...(isRealTransition && autoTransition === "entregado" && !order.delivered_at
      ? { delivered_at: checkedAt }
      : {}),
  }

  let query = admin.from("ordenes").update(updatePayload as never).eq("id", order.id)
  if (isRealTransition) {
    // Optimistic concurrency: sólo aplica el avance de estado si el pedido
    // sigue en el mismo estado que se leyó -- si un admin lo cambió
    // manualmente mientras tanto, la sincronización automática no lo pisa.
    query = query.eq("estado", order.estado)
  }

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

  return {
    snapshot,
    checkedAt,
    statusChanged,
    newEstado: statusChanged ? autoTransition : null,
  }
}
