import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"

import { sanitizeAndreaniMessage } from "./client.ts"
import { parseAndreaniTimestamp } from "./tracking-timestamps.ts"
import type { AndreaniTrackingEvent, AndreaniUnrecognizedTrackingEvent } from "./types.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Historial de tracking Andreani (`andreani_tracking_events`): un registro por
 * evento informado por Andreani, de un pedido o de un tramo de reclamo. Es
 * idempotente por `dedupe_key` (alcance + tracking + evento + fecha cruda de
 * Andreani): el cron puede consultar el mismo envío cada 15 minutos sin
 * duplicar filas. Escribir el historial nunca hace fallar la sincronización.
 */
export interface AndreaniTrackingHistoryEvent {
  dedupeKey: string
  code: string
  text: string | null
  cycle: string | null
  /** Instante UTC; null sólo si Andreani mandó una fecha imposible de interpretar. */
  at: string | null
  recognized: boolean
  details: Record<string, string>
}

export interface AndreaniTrackingHistoryScope {
  orderId: number
  claimShipmentId?: number | null
  tracking: string
}

export interface AndreaniTrackingHistoryTransition {
  dedupeKey: string
  previousStatus: string
  newStatus: string
}

function safeTimestamp(value: string) {
  try {
    return parseAndreaniTimestamp(value)
  } catch {
    return null
  }
}

function compactDetails(values: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  )
}

function scopeKey(scope: AndreaniTrackingHistoryScope) {
  return scope.claimShipmentId ? `claim-shipment:${scope.claimShipmentId}` : `order:${scope.orderId}`
}

/** Eventos (reconocidos y no) en orden cronológico, con su clave de idempotencia. */
export function collectAndreaniTrackingHistoryEvents(
  scope: AndreaniTrackingHistoryScope,
  tracking: {
    eventos: readonly AndreaniTrackingEvent[]
    eventosNoReconocidos: readonly AndreaniUnrecognizedTrackingEvent[]
  },
): AndreaniTrackingHistoryEvent[] {
  const prefix = `${scopeKey(scope)}:${scope.tracking}`
  const build = (
    event: AndreaniTrackingEvent | AndreaniUnrecognizedTrackingEvent,
    recognized: boolean,
  ): AndreaniTrackingHistoryEvent => ({
    dedupeKey: `${prefix}:${event.Evento}:${event.Fecha.trim()}`,
    code: event.Evento,
    text: event.Estado?.trim() || null,
    cycle: event.Ciclo?.trim() || null,
    at: safeTimestamp(event.Fecha),
    recognized,
    details: compactDetails({
      fecha: event.Fecha,
      motivo: event.Motivo,
      submotivo: event.Submotivo,
      sucursal: event.Sucursal,
    }),
  })
  const events = [
    ...tracking.eventos.map((event) => build(event, true)),
    ...tracking.eventosNoReconocidos.map((event) => build(event, false)),
  ]
  const unique = [...new Map(events.map((event) => [event.dedupeKey, event])).values()]
  return unique.sort((left, right) =>
    (left.at ? Date.parse(left.at) : Number.POSITIVE_INFINITY) -
    (right.at ? Date.parse(right.at) : Number.POSITIVE_INFINITY),
  )
}

/**
 * Persiste los eventos que todavía no estaban registrados y devuelve SÓLO
 * los nuevos (sirve para auditar/alertar una única vez por evento). La
 * transición, si hubo, queda en el evento que la provocó. Un error de la
 * base se registra en el log y devuelve [] -- nunca interrumpe el tracking;
 * el próximo ciclo vuelve a intentar (es idempotente).
 */
export async function recordAndreaniTrackingHistory(
  admin: AdminClient,
  scope: AndreaniTrackingHistoryScope,
  events: readonly AndreaniTrackingHistoryEvent[],
  transition: AndreaniTrackingHistoryTransition | null,
): Promise<AndreaniTrackingHistoryEvent[]> {
  if (!scope.tracking || events.length === 0) return []
  const rows = events.map((event) => ({
    order_id: scope.orderId,
    claim_shipment_id: scope.claimShipmentId ?? null,
    source: "andreani",
    tracking: scope.tracking,
    event_code: event.code.slice(0, 200),
    event_text: event.text?.slice(0, 500) ?? null,
    event_cycle: event.cycle?.slice(0, 100) ?? null,
    event_at: event.at,
    recognized: event.recognized,
    review_required: !event.recognized,
    previous_status: transition?.dedupeKey === event.dedupeKey ? transition.previousStatus : null,
    new_status: transition?.dedupeKey === event.dedupeKey ? transition.newStatus : null,
    details: event.details,
    dedupe_key: event.dedupeKey,
  }))

  try {
    const { data, error } = await admin
      .from("andreani_tracking_events")
      .upsert(rows as never, { onConflict: "dedupe_key", ignoreDuplicates: true })
      .select("dedupe_key")
    if (error) throw new Error(error.message)
    const inserted = new Set(((data ?? []) as Array<{ dedupe_key: string }>).map((row) => row.dedupe_key))
    return events.filter((event) => inserted.has(event.dedupeKey))
  } catch (error) {
    console.error("ANDREANI_TRACKING_HISTORY_ERROR", {
      orderId: scope.orderId,
      claimShipmentId: scope.claimShipmentId ?? null,
      message: sanitizeAndreaniMessage(error instanceof Error ? error.message : String(error)),
      // Lo no reconocido nunca se pierde en silencio: si no se pudo guardar,
      // al menos queda crudo en el log de esta corrida.
      unrecognized: events.filter((event) => !event.recognized).map((event) => ({
        code: event.code,
        text: event.text,
        at: event.at,
      })),
    })
    return []
  }
}

/** Log estructurado (una vez por evento nuevo) de lo que BEYONIX no sabe interpretar. */
export function logUnrecognizedAndreaniEvents(
  scope: AndreaniTrackingHistoryScope,
  inserted: readonly AndreaniTrackingHistoryEvent[],
) {
  for (const event of inserted) {
    if (event.recognized) continue
    console.warn("ANDREANI_TRACKING_UNKNOWN_EVENT", {
      orderId: scope.orderId,
      claimShipmentId: scope.claimShipmentId ?? null,
      tracking: scope.tracking,
      code: event.code,
      text: event.text,
      cycle: event.cycle,
      at: event.at,
    })
  }
}
