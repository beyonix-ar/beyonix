import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"

import { AndreaniError, sanitizeAndreaniMessage, type AndreaniClientOptions } from "./client.ts"
import {
  ANDREANI_ORDER_TRACKING_SELECT,
  syncAndreaniOrderTracking,
  type AndreaniOrderTrackingRow,
} from "./order-tracking-sync.ts"
import { ORDER_STATES_CLOSED_TO_AUTO_SYNC } from "./tracking-status-mapping.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Tamaño de lote y frecuencia mínima entre consultas para el mismo pedido:
 * conservador a propósito -- ver sección "Sincronización" del cierre
 * Andreani. Con un cron cada 15 min y este intervalo mínimo, un pedido
 * activo se consulta como máximo cada ~20 min, nunca en cada corrida si ya
 * se consultó recientemente.
 *
 * 15 (no más) porque el scheduler real (timer systemd de la VPS,
 * deploy/systemd/beyonix-andreani-sync-tracking.{service,timer}) corta la
 * llamada a los 120 s: cada pedido implica 1-2 llamadas GET reales a
 * Andreani (login se cachea a nivel de módulo tras la primera), así que el
 * lote entero debe terminar con margen amplio.
 */
const DEFAULT_BATCH_SIZE = 15
const DEFAULT_MIN_RECHECK_INTERVAL_MS = 20 * 60 * 1000
/** Margen para reintentar un pedido que falló en el próximo tick del timer (15 min). */
const FAILED_RETRY_MARGIN_MS = 60 * 1000

export interface AndreaniTrackingSyncBatchResult {
  /** Pedidos elegibles encontrados en este lote. */
  checked: number
  /** Consultas a Andreani que se completaron sin error. */
  updated: number
  /** De las actualizadas, cuántas efectivamente avanzaron `ordenes.estado`. */
  statusChanged: number
  /** Consultas que fallaron (quedan para el próximo ciclo, no bloquean el lote). */
  errors: number
  /** Eventos Andreani fuera del maestro detectados por primera vez en este lote. */
  unknownEvents: number
  /** Pedidos que no llegaron a consultarse por agotar el tiempo de la corrida. */
  deferred: number
}

/**
 * Un pedido que falla queda "consultado hace casi el intervalo mínimo": sigue
 * entrando en el próximo tick (mismo reintento que antes), pero detrás de
 * los pedidos más atrasados. Sin esto, 15 envíos que fallan siempre (p. ej.
 * un envío dado de baja en Andreani) ocupaban la cabeza del lote en cada
 * corrida y el resto nunca se sincronizaba.
 */
async function deferFailedOrder(admin: AdminClient, orderId: number, now: Date, minRecheckIntervalMs: number) {
  const retryCheckedAt = new Date(now.getTime() - minRecheckIntervalMs + FAILED_RETRY_MARGIN_MS).toISOString()
  const { error } = await admin
    .from("ordenes")
    .update({ andreani_tracking_checked_at: retryCheckedAt } as never)
    .eq("id", orderId)
  if (error) {
    console.error("ANDREANI_TRACKING_SYNC_DEFER_ERROR", { orderId, message: sanitizeAndreaniMessage(error.message) })
  }
}

/**
 * Sincroniza tracking para el lote de pedidos Andreani activos más
 * atrasados. Pensado para correr desde un cron server-side (nunca desde el
 * browser): batch acotado, rate-limited por pedido, nunca vuelve a
 * consultar un pedido ya cerrado (entregado/cancelado/devuelto/en
 * devolución) ni uno consultado hace menos del intervalo mínimo.
 */
export async function runAndreaniTrackingSyncBatch(
  admin: AdminClient,
  dependencies: {
    now?: () => Date
    batchSize?: number
    minRecheckIntervalMs?: number
    /**
     * Instante (epoch ms) a partir del cual no se empieza ningún pedido más:
     * lo pendiente queda para el próximo tick en vez de que el timer corte
     * la llamada a mitad de lote.
     */
    deadlineMs?: number
    /** Sólo para tests: evita pegarle a la red real de Andreani. */
    clientOptions?: AndreaniClientOptions
  } = {},
): Promise<AndreaniTrackingSyncBatchResult> {
  const now = dependencies.now?.() ?? new Date()
  const batchSize = dependencies.batchSize ?? DEFAULT_BATCH_SIZE
  const minRecheckIntervalMs =
    dependencies.minRecheckIntervalMs ?? DEFAULT_MIN_RECHECK_INTERVAL_MS
  const staleBefore = new Date(now.getTime() - minRecheckIntervalMs).toISOString()
  const closedStatesList = `(${ORDER_STATES_CLOSED_TO_AUTO_SYNC.join(",")})`

  const { data, error } = await admin
    .from("ordenes")
    .select(ANDREANI_ORDER_TRACKING_SELECT)
    .not("andreani_envio_id", "is", null)
    .not("estado", "in", closedStatesList)
    .or(`andreani_tracking_checked_at.is.null,andreani_tracking_checked_at.lt.${staleBefore}`)
    .order("andreani_tracking_checked_at", { ascending: true, nullsFirst: true })
    .limit(batchSize)

  if (error) {
    // Investigación Gateway Timeout (2026-09-11): este mensaje quedaba fijo
    // sin importar la causa real -- ocultaba si Supabase/PostgREST había
    // devuelto un 504 ("Gateway Timeout"), un error de RLS, o cualquier otra
    // cosa. Se propaga el detalle real (saneado) para que quede diagnosticable.
    throw new AndreaniError(
      "REQUEST_FAILED",
      `No se pudieron obtener los pedidos Andreani activos para sincronizar: ${sanitizeAndreaniMessage(error.message)}`,
    )
  }

  const orders = (data ?? []) as unknown as AndreaniOrderTrackingRow[]
  let updated = 0
  let statusChanged = 0
  let errors = 0
  let unknownEvents = 0
  let deferred = 0

  // Secuencial a propósito: el token Andreani ya se cachea a nivel de
  // módulo (client.ts) y se reutiliza entre pedidos de la misma corrida --
  // no hace falta concurrencia, y evita ráfagas de requests simultáneas
  // contra Andreani por un solo cron tick.
  for (const order of orders) {
    if (dependencies.deadlineMs !== undefined && Date.now() >= dependencies.deadlineMs) {
      deferred += 1
      continue
    }
    try {
      const result = await syncAndreaniOrderTracking(admin, order, {
        actorType: "system",
        actorId: null,
        clientOptions: dependencies.clientOptions,
      })
      updated += 1
      if (result.statusChanged) statusChanged += 1
      unknownEvents += result.newHistoryEvents.filter((event) => !event.recognized).length
    } catch (syncError) {
      errors += 1
      console.error("ANDREANI_TRACKING_SYNC_BATCH_ITEM_ERROR", {
        orderId: order.id,
        operation: "tracking_sync",
        environment: order.andreani_creation_environment,
        message: sanitizeAndreaniMessage(
          syncError instanceof Error ? syncError.message : String(syncError),
        ),
      })
      await deferFailedOrder(admin, order.id, now, minRecheckIntervalMs)
    }
  }

  return { checked: orders.length, updated, statusChanged, errors, unknownEvents, deferred }
}
