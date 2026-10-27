"use client"

import { useEffect, useMemo, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react"

import {
  applySystemHealthFailure,
  applySystemHealthResponse,
  createInitialSystemHealthState,
  INTEGRATION_ORDER,
  presentIntegrationHealth,
  SYSTEM_HEALTH_POLL_MS,
  type SystemHealthResponse,
  type SystemHealthState,
} from "@/lib/admin/system-health"
import { createAnalyticsRefreshScheduler } from "@/lib/analytics/refresh-scheduler"
import { getSystemHealth } from "@/lib/supabase/queries/dashboard"

const CLOCK_RESOLUTION_MS = 10_000

export type FetchSystemHealth =(options: {
  force: boolean
  signal: AbortSignal
}) => Promise<SystemHealthResponse>

export interface UseSystemHealthOptions {
  fetchHealth?: FetchSystemHealth
  intervalMs?: number
  tickMs?: number
}

/**
 * Estado de integraciones, separado de los datos generales del Dashboard: la
 * carga del Dashboard no puede pisar un resultado de health.
 *
 * Un único ciclo (scheduler de Analítica): un timer, sin requests
 * superpuestos, sin consultas con la pestaña oculta y UNA sola al volver si
 * venció el intervalo. "Comprobar ahora" se suma al ciclo en curso o, si no
 * hay, fuerza una comprobación real en el servidor.
 */
function createSystemHealthController(
  fetchHealth: FetchSystemHealth,
  setState: Dispatch<SetStateAction<SystemHealthState>>,
  intervalMs: number,
) {
  let forceNext = false
  const scheduler = createAnalyticsRefreshScheduler({
    intervalMs,
    isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    runTasks: async (signal) => {
      const force = forceNext
      forceNext = false
      const attemptedAt = new Date().toISOString()
      try {
        const response = await fetchHealth({ force, signal })
        if (signal.aborted) return false
        setState((current) => applySystemHealthResponse(current, response, attemptedAt))
        return true
      } catch (error) {
        if (signal.aborted) return false
        setState((current) =>
          applySystemHealthFailure(
            current,
            error instanceof Error && error.message
              ? error.message
              : "No se pudo consultar el estado del sistema.",
            attemptedAt,
          ),
        )
        return false
      }
    },
  })

  return {
    scheduler,
    refreshNow() {
      if (!scheduler.getSnapshot().isRefreshing) forceNext = true
      return scheduler.refreshNow()
    },
  }
}

export function useSystemHealth({
  fetchHealth = getSystemHealth,
  intervalMs = SYSTEM_HEALTH_POLL_MS,
  tickMs = 1_000,
}: UseSystemHealthOptions = {}) {
  const [state, setState] = useState(createInitialSystemHealthState)
  const [controller] = useState(() =>
    createSystemHealthController(fetchHealth, setState, intervalMs),
  )
  const { scheduler } = controller
  const refreshing = useSyncExternalStore(
    scheduler.subscribe,
    () => scheduler.getSnapshot().isRefreshing,
    () => false,
  )

  // Reloj de presentación: el mismo timer del ciclo lo avanza. Redondeado a
  // CLOCK_RESOLUTION_MS, React descarta el setState si no cambió (≤ 1 render
  // cada 10 s) y un resultado vence aunque no llegue otra respuesta.
  const [clockMs, setClockMs] = useState(0)

  useEffect(() => {
    const onTick = () => {
      setClockMs(Math.floor(Date.now() / CLOCK_RESOLUTION_MS) * CLOCK_RESOLUTION_MS)
      scheduler.tick()
    }
    setClockMs(Date.now())
    void scheduler.refreshNow()
    const interval = setInterval(onTick, tickMs)
    document.addEventListener("visibilitychange", onTick)
    return () => {
      clearInterval(interval)
      document.removeEventListener("visibilitychange", onTick)
      scheduler.cancel()
    }
  }, [scheduler, tickMs])

  const items = useMemo(
    () => INTEGRATION_ORDER.map((id) => presentIntegrationHealth(id, state, clockMs)),
    [state, clockMs],
  )

  return {
    state,
    items,
    refreshing,
    refreshNow: controller.refreshNow,
  }
}
