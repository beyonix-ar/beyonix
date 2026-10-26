/**
 * Ciclo único de auto-actualización de Admin > Analítica (sin React, para
 * poder probarlo con un reloj simulado).
 *
 * - Cuenta regresiva por timestamps: el próximo refresh vence en `deadline`
 *   (Date.now() + intervalo) y lo que se muestra se deriva de la hora real,
 *   no de restar 1 por segundo. Una pestaña dormida o con timers frenados ve
 *   el vencimiento al primer `tick()` y dispara UNA sola actualización.
 * - Nunca hay dos ciclos a la vez: `refreshNow()` (botón o vencimiento) se
 *   suma al ciclo en curso. `restart()` (cambio de filtro) cancela el ciclo
 *   en curso -- sus datos serían del período anterior -- y arranca otro.
 * - Al terminar cada ciclo, bien o mal, el contador vuelve a empezar.
 * - Con la pestaña oculta no se refresca: al volver, un único refresh.
 */

export const ANALYTICS_REFRESH_INTERVAL_MS = 60_000

export interface AnalyticsRefreshSnapshot {
  secondsRemaining: number
  isRefreshing: boolean
  /** Sube al terminar cada ciclo (para que un módulo reaccione si lo necesita). */
  refreshVersion: number
  /** El último ciclo tuvo al menos una tarea fallida. */
  lastRefreshFailed: boolean
}

export interface AnalyticsRefreshScheduler {
  getSnapshot(): AnalyticsRefreshSnapshot
  subscribe(listener: () => void): () => void
  /** Evalúa el vencimiento con la hora actual (lo llama el único timer). */
  tick(): void
  /** Actualiza ya; si hay un ciclo en curso, devuelve ese mismo. */
  refreshNow(): Promise<void>
  /** Descarta el ciclo en curso (si hay) y empieza uno nuevo ya. */
  restart(): Promise<void>
  /** Cancela el ciclo en curso sin aplicar su resultado (al desmontar). */
  cancel(): void
}

export interface AnalyticsRefreshSchedulerOptions {
  /** Ejecuta todas las tareas registradas; `true` si todas terminaron bien. */
  runTasks: (signal: AbortSignal) => Promise<boolean>
  intervalMs?: number
  now?: () => number
  isHidden?: () => boolean
}

export function formatCountdown(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds))
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`
}

export function createAnalyticsRefreshScheduler({
  runTasks,
  intervalMs = ANALYTICS_REFRESH_INTERVAL_MS,
  now = Date.now,
  isHidden = () => false,
}: AnalyticsRefreshSchedulerOptions): AnalyticsRefreshScheduler {
  const listeners = new Set<() => void>()
  let deadline = now() + intervalMs
  let inFlight: { id: number; controller: AbortController; promise: Promise<void> } | null = null
  let cycleId = 0
  let snapshot: AnalyticsRefreshSnapshot = {
    secondsRemaining: Math.ceil(intervalMs / 1000),
    isRefreshing: false,
    refreshVersion: 0,
    lastRefreshFailed: false,
  }

  const remainingSeconds = () => Math.min(Math.ceil(intervalMs / 1000), Math.max(0, Math.ceil((deadline - now()) / 1000)))

  const publish = (next: Partial<AnalyticsRefreshSnapshot>) => {
    const merged = { ...snapshot, ...next }
    if (
      merged.secondsRemaining === snapshot.secondsRemaining &&
      merged.isRefreshing === snapshot.isRefreshing &&
      merged.refreshVersion === snapshot.refreshVersion &&
      merged.lastRefreshFailed === snapshot.lastRefreshFailed
    ) return
    snapshot = merged
    for (const listener of listeners) listener()
  }

  const startCycle = () => {
    const id = ++cycleId
    const controller = new AbortController()
    publish({ isRefreshing: true, secondsRemaining: 0 })
    const promise = (async () => {
      let ok = false
      try {
        ok = await runTasks(controller.signal)
      } catch {
        ok = false
      }
      if (id !== cycleId) return
      inFlight = null
      deadline = now() + intervalMs
      publish({
        isRefreshing: false,
        secondsRemaining: remainingSeconds(),
        refreshVersion: snapshot.refreshVersion + 1,
        lastRefreshFailed: !ok,
      })
    })()
    inFlight = { id, controller, promise }
    return promise
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    tick() {
      if (inFlight) return
      if (now() >= deadline) {
        if (isHidden()) {
          publish({ secondsRemaining: 0 })
          return
        }
        void startCycle()
        return
      }
      publish({ secondsRemaining: remainingSeconds() })
    },
    refreshNow() {
      return inFlight?.promise ?? startCycle()
    },
    restart() {
      inFlight?.controller.abort()
      inFlight = null
      return startCycle()
    },
    cancel() {
      if (!inFlight) return
      inFlight.controller.abort()
      inFlight = null
      cycleId += 1
      deadline = now() + intervalMs
      publish({ isRefreshing: false, secondsRemaining: remainingSeconds() })
    },
  }
}
