// Estado de la cancelación automática (NC C → reintegro) tal como la ve
// Admin. "Procesando automáticamente" sólo mientras exista actividad real del
// worker: un lease vigente o un próximo intento todavía no vencido. Si el
// worker no tomó el pedido a tiempo (timer caído, nunca instalado) o lo derivó
// a revisión manual, el pedido pasa a "Requiere acción" y vuelve el flujo
// manual de Admin, nunca un "procesando" eterno.

/** Margen sobre el próximo intento antes de considerar el worker trabado (corre cada minuto). */
export const AUTO_CANCELLATION_STALE_MS = 10 * 60_000

export type AutomaticCancellationOrder = {
  estado?: string | null
  financial_status?: string | null
  invoice_status?: string | null
  invoice_queued_at?: string | null
  invoice_requested_at?: string | null
  cancellation_requested_at?: string | null
  cancelled_at?: string | null
  refund_pending_at?: string | null
  auto_cancellation_next_attempt_at?: string | null
  auto_cancellation_claimed_until?: string | null
  auto_cancellation_error?: string | null
}

export type AutomaticCancellationControl = { enabled: boolean; cutoffAt: string | null }

export type AutomaticCancellationStatus =
  | { state: "processing" }
  | { state: "requires_action"; reason: "stalled" | "manual"; error: string | null }

const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}
const latest = (...values: Array<string | null | undefined>) => {
  const times = values.map(time).filter((value): value is number => value !== null)
  return times.length ? Math.max(...times) : null
}

/** Misma elegibilidad que claim_auto_cancellation (20261015190000). null = no es automática. */
export function getAutomaticCancellationStatus(
  order: AutomaticCancellationOrder,
  control: AutomaticCancellationControl | null,
  now = Date.now(),
): AutomaticCancellationStatus | null {
  const cutoff = time(control?.cutoffAt)
  if (!control?.enabled || cutoff === null) return null
  if (order.estado !== "cancelado" || order.financial_status !== "refund_pending" || !order.invoice_queued_at) return null
  const lastEvent = latest(order.invoice_queued_at, order.cancellation_requested_at, order.cancelled_at, order.refund_pending_at)
  if (lastEvent === null || lastEvent <= cutoff) return null

  const error = order.auto_cancellation_error?.trim() || null
  // release_auto_cancellation(…, null): el worker lo derivó a Admin.
  if (order.auto_cancellation_next_attempt_at === "infinity") return { state: "requires_action", reason: "manual", error }
  const claimedUntil = time(order.auto_cancellation_claimed_until)
  if (claimedUntil !== null && claimedUntil > now) return { state: "processing" }
  // Sin Factura C todavía: avanza la cola de facturación (con su propio estado).
  if (order.invoice_status !== "authorized") return { state: "processing" }
  // '-infinity' (nunca tomado): se debe desde que hay cancelación y factura.
  const due = time(order.auto_cancellation_next_attempt_at)
    ?? latest(order.cancellation_requested_at, order.cancelled_at, order.refund_pending_at, order.invoice_requested_at)
  if (due !== null && now - due > AUTO_CANCELLATION_STALE_MS) return { state: "requires_action", reason: "stalled", error }
  return { state: "processing" }
}
