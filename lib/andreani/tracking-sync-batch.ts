import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"

import { AndreaniError, sanitizeAndreaniMessage, type AndreaniClientOptions } from "./client.ts"
import { syncAndreaniOrderTracking, type AndreaniOrderTrackingRow } from "./order-tracking-sync.ts"
import { ORDER_STATES_CLOSED_TO_AUTO_SYNC } from "./tracking-status-mapping.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Tamaño de lote y frecuencia mínima entre consultas para el mismo pedido:
 * conservador a propósito -- ver sección "Sincronización" del cierre
 * Andreani. Con un cron cada 15 min y este intervalo mínimo, un pedido
 * activo se consulta como máximo cada ~20 min, nunca en cada corrida si ya
 * se consultó recientemente.
 *
 * 15 (no más) porque la función programada real (Netlify Scheduled
 * Function, ver netlify/functions/andreani-sync-tracking.mts) corre en un
 * runtime síncrono con límite duro de 30s: cada pedido implica 1-2 llamadas
 * GET reales a Andreani (login se cachea a nivel de módulo tras la primera),
 * así que el lote entero debe terminar con margen amplio.
 */
const DEFAULT_BATCH_SIZE = 15
const DEFAULT_MIN_RECHECK_INTERVAL_MS = 20 * 60 * 1000

const ORDER_TRACKING_SYNC_SELECT =
  "id, estado, delivered_at, andreani_tracking, andreani_envio_id, andreani_creation_environment, cliente_email, cliente_nombre, tracking_number, tracking_url"

export interface AndreaniTrackingSyncBatchResult {
  /** Pedidos elegibles encontrados en este lote. */
  checked: number
  /** Consultas a Andreani que se completaron sin error. */
  updated: number
  /** De las actualizadas, cuántas efectivamente avanzaron `ordenes.estado`. */
  statusChanged: number
  /** Consultas que fallaron (quedan para el próximo ciclo, no bloquean el lote). */
  errors: number
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
    .select(ORDER_TRACKING_SYNC_SELECT)
    .not("andreani_envio_id", "is", null)
    .not("estado", "in", closedStatesList)
    .or(`andreani_tracking_checked_at.is.null,andreani_tracking_checked_at.lt.${staleBefore}`)
    .order("andreani_tracking_checked_at", { ascending: true, nullsFirst: true })
    .limit(batchSize)

  if (error) {
    throw new AndreaniError(
      "REQUEST_FAILED",
      "No se pudieron obtener los pedidos Andreani activos para sincronizar.",
    )
  }

  const orders = (data ?? []) as unknown as AndreaniOrderTrackingRow[]
  let updated = 0
  let statusChanged = 0
  let errors = 0

  // Secuencial a propósito: el token Andreani ya se cachea a nivel de
  // módulo (client.ts) y se reutiliza entre pedidos de la misma corrida --
  // no hace falta concurrencia, y evita ráfagas de requests simultáneas
  // contra Andreani por un solo cron tick.
  for (const order of orders) {
    try {
      const result = await syncAndreaniOrderTracking(admin, order, {
        actorType: "system",
        actorId: null,
        clientOptions: dependencies.clientOptions,
      })
      updated += 1
      if (result.statusChanged) statusChanged += 1
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
    }
  }

  return { checked: orders.length, updated, statusChanged, errors }
}
