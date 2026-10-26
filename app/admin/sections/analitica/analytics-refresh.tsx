"use client"

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { RefreshCw } from "lucide-react"

import {
  createAnalyticsRefreshScheduler,
  formatCountdown,
  type AnalyticsRefreshScheduler,
  type AnalyticsRefreshSnapshot,
} from "@/lib/analytics/refresh-scheduler"

/**
 * Fuente única de auto-actualización de Admin > Analítica: UN timer para toda
 * la sección. Cada módulo registra su tarea de carga con
 * `useAnalyticsRefreshTask`; cada ciclo (vencimiento, "Actualizar ahora" o
 * cambio de período) ejecuta todas las tareas juntas, una sola vez.
 */

export type AnalyticsRefreshTask = (signal: AbortSignal) => Promise<void>

const TICK_MS = 250

interface AnalyticsRefreshContextValue {
  scheduler: AnalyticsRefreshScheduler
  register: (task: AnalyticsRefreshTask) => () => void
}

const AnalyticsRefreshContext = createContext<AnalyticsRefreshContextValue | null>(null)

function createRefreshContext(): AnalyticsRefreshContextValue {
  const tasks = new Set<AnalyticsRefreshTask>()
  const scheduler = createAnalyticsRefreshScheduler({
    isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    runTasks: async (signal) => {
      const results = await Promise.allSettled(Array.from(tasks, (task) => task(signal)))
      return results.every((result) => result.status === "fulfilled")
    },
  })
  return {
    scheduler,
    register(task) {
      tasks.add(task)
      return () => {
        tasks.delete(task)
      }
    },
  }
}

export function AnalyticsRefreshProvider({ children }: { children: ReactNode }) {
  const [value] = useState(createRefreshContext)

  useEffect(() => {
    const { scheduler } = value
    const interval = window.setInterval(() => scheduler.tick(), TICK_MS)
    const onVisibility = () => scheduler.tick()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
      scheduler.cancel()
    }
  }, [value])

  return <AnalyticsRefreshContext.Provider value={value}>{children}</AnalyticsRefreshContext.Provider>
}

function useRefreshContext() {
  const context = useContext(AnalyticsRefreshContext)
  if (!context) throw new Error("useAnalyticsRefresh requiere AnalyticsRefreshProvider.")
  return context
}

export function useAnalyticsRefresh(): AnalyticsRefreshSnapshot & {
  refreshNow: () => Promise<void>
  restart: () => Promise<void>
} {
  const { scheduler } = useRefreshContext()
  const snapshot = useSyncExternalStore(scheduler.subscribe, scheduler.getSnapshot, scheduler.getSnapshot)
  return { ...snapshot, refreshNow: scheduler.refreshNow, restart: scheduler.restart }
}

/**
 * Suscribe la carga de un módulo al ciclo global. La tarea debe lanzar si
 * falló (el ciclo lo informa) y respetar `signal` (un cambio de período
 * cancela el ciclo anterior).
 */
export function useAnalyticsRefreshTask(task: AnalyticsRefreshTask) {
  const { register } = useRefreshContext()
  useEffect(() => register(task), [register, task])
}

/** "Próxima actualización en: 01:00" + "Actualizar ahora", arriba a la derecha. */
export function AnalyticsRefreshControl() {
  const { secondsRemaining, isRefreshing, lastRefreshFailed, refreshNow } = useAnalyticsRefresh()

  return (
    <div className="admin-analytics-refresh" role="group" aria-label="Actualización de Analítica">
      <p className="admin-analytics-refresh-status" aria-live="polite" aria-atomic="true">
        {isRefreshing ? (
          "Actualizando..."
        ) : (
          <>
            Próxima actualización en: <span className="tabular-nums">{formatCountdown(secondsRemaining)}</span>
          </>
        )}
      </p>
      <button
        type="button"
        onClick={() => void refreshNow()}
        disabled={isRefreshing}
        className="admin-dash-chip-button"
      >
        <RefreshCw className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`} aria-hidden="true" />
        Actualizar ahora
      </button>
      {lastRefreshFailed && !isRefreshing && (
        <p className="admin-analytics-refresh-error" role="status">
          No se pudo actualizar. Se muestran los últimos datos.
        </p>
      )}
    </div>
  )
}
