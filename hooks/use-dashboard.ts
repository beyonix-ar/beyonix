"use client"

import { useCallback, useEffect, useState } from "react"

import {
  getDashboardData,
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

  const loadDashboard = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      setData(await getDashboardData())
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

  return {
    ...data,
    loading,
    error,
    reloadDashboard: loadDashboard,
  }
}
