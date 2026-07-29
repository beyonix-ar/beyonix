"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  getDashboardData,
  getSystemHealth,
  type DashboardCommercialSale,
  type DashboardFinancialSummary,
  type DashboardRecentActivity,
  type DashboardSearchItem,
  type DashboardStats,
  type DashboardSystemStatus,
  type LowStockItem,
} from "@/lib/supabase/queries/dashboard"
import type { SupabasePedido } from "@/lib/supabase/types"

interface DashboardState {
  role: "operador" | "admin" | "super_admin" | null
  stats: DashboardStats | null
  financialSummary: DashboardFinancialSummary | null
  lowStock: LowStockItem[]
  recentOrders: SupabasePedido[]
  commercialSales: DashboardCommercialSale[]
  recentActivity: DashboardRecentActivity[]
  systemStatus: DashboardSystemStatus[]
  searchIndex: DashboardSearchItem[]
}

function getDashboardErrorDetails(err: unknown) {
  if (!err || typeof err !== "object") {
    return {
      message: String(err),
      details: null,
      hint: null,
      code: null,
      status: null,
    }
  }

  const candidate = err as {
    message?: unknown
    details?: unknown
    hint?: unknown
    code?: unknown
    status?: unknown
    body?: unknown
    name?: unknown
  }

  return {
    message:
      typeof candidate.message === "string"
        ? candidate.message
        : JSON.stringify(err),
    details: candidate.details ?? null,
    hint: candidate.hint ?? null,
    code: candidate.code ?? null,
    status: candidate.status ?? null,
    body: candidate.body ?? null,
    name: candidate.name ?? null,
  }
}

export function useDashboard() {
  const [data, setData] = useState<DashboardState>({
    role: null,
    stats: null,
    financialSummary: null,
    lowStock: [],
    recentOrders: [],
    commercialSales: [],
    recentActivity: [],
    systemStatus: [],
    searchIndex: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [healthRefreshing, setHealthRefreshing] = useState(true)
  const [healthReady, setHealthReady] = useState(false)
  const [healthCheckedAt, setHealthCheckedAt] = useState<string | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const healthRequestRef = useRef<Promise<void> | null>(null)

  const loadDashboard = useCallback(async (force = false) => {
    try {
      setLoading(true)
      setError(null)
      setData(await getDashboardData({ force }))
    } catch (err) {
      console.warn("DASHBOARD_LOAD_WARNING", getDashboardErrorDetails(err))
      setError("No se pudo cargar el dashboard.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const refreshSystemHealth = useCallback(async () => {
    if (healthRequestRef.current) return healthRequestRef.current

    const request = (async () => {
      try {
        setHealthRefreshing(true)
        setHealthError(null)
        const health = await getSystemHealth()
        setData((current) => ({
          ...current,
          systemStatus: health.checks,
        }))
        setHealthCheckedAt(health.checkedAt)
        setHealthReady(true)
      } catch (healthCause) {
        setHealthError(
          healthCause instanceof Error
            ? healthCause.message
            : "No se pudo comprobar el estado del sistema.",
        )
        setData((current) => ({
          ...current,
          systemStatus: current.systemStatus.map((item) => ({
            ...item,
            status: "unknown",
            detail: "No se pudo ejecutar una comprobación actual.",
            checkedAt: new Date().toISOString(),
            verified: false,
            latencyMs: null,
          })),
        }))
        setHealthCheckedAt(new Date().toISOString())
        setHealthReady(true)
      } finally {
        setHealthRefreshing(false)
        healthRequestRef.current = null
      }
    })()

    healthRequestRef.current = request
    return request
  }, [])

  useEffect(() => {
    void refreshSystemHealth()
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshSystemHealth()
      }
    }, 30_000)
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshSystemHealth()
      }
    }
    document.addEventListener("visibilitychange", handleVisibility)

    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener("visibilitychange", handleVisibility)
    }
  }, [refreshSystemHealth])

  return {
    ...data,
    loading,
    error,
    reloadDashboard: () => loadDashboard(true),
    healthRefreshing,
    healthReady,
    healthCheckedAt,
    healthError,
    refreshSystemHealth,
  }
}
