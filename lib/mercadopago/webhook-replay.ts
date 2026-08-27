import "server-only"

const REPLAY_ENTRY_TTL_MS = 15 * 60 * 1000
const MAX_REPLAY_ENTRIES = 5_000

interface ReplayEntry {
  expiresAt: number
}

const replayEntries = new Map<string, ReplayEntry>()

function getReplayKey(paymentId: string, requestId: string) {
  return `${paymentId.toLowerCase()}:${requestId}`
}

function pruneReplayEntries(nowMs: number) {
  for (const [key, entry] of replayEntries) {
    if (entry.expiresAt <= nowMs) replayEntries.delete(key)
  }

  while (replayEntries.size >= MAX_REPLAY_ENTRIES) {
    const oldestKey = replayEntries.keys().next().value
    if (!oldestKey) break
    replayEntries.delete(oldestKey)
  }
}

/**
 * Reserva sincrónicamente una entrega firmada dentro de la instancia actual.
 * La barrera transaccional de pago sigue siendo la protección global entre
 * instancias serverless.
 */
export function claimMercadoPagoWebhookDelivery(
  paymentId: string,
  requestId: string,
  nowMs = Date.now(),
) {
  pruneReplayEntries(nowMs)
  const key = getReplayKey(paymentId, requestId)

  if (replayEntries.has(key)) return null

  replayEntries.set(key, { expiresAt: nowMs + REPLAY_ENTRY_TTL_MS })
  return key
}

export function releaseMercadoPagoWebhookDelivery(claimKey: string) {
  replayEntries.delete(claimKey)
}

export function resetMercadoPagoWebhookReplayCacheForTests() {
  replayEntries.clear()
}
