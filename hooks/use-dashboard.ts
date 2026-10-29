"use client"

import { useCallback, useEffect, useState } from "react"

import {
  getDashboardData,
  type DashboardCommercialSale,
  type DashboardDataResponse,
  type DashboardFinancialSummary,
  type DashboardRecentActivity,
  type DashboardSearchItem,
  type DashboardStats,
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
  paidExpensesByDate: DashboardDataResponse["paidExpensesByDate"]
  recentActivity: DashboardRecentActivity[]
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

/**
 * Datos generales del Dashboard. El estado de integraciones vive aparte
 * (useSystemHealth): esta carga nunca lo toca.
 */
export function useDashboard({
  load = getDashboardData,
}: {
  load?: (options: { force?: boolean }) => Promise<DashboardDataResponse>
} = {}) {
  const [data, setData] = useState<DashboardState>({
    role: null,
    stats: null,
    financialSummary: null,
    lowStock: [],
    recentOrders: [],
    commercialSales: [],
    paidExpensesByDate: [],
    recentActivity: [],
    searchIndex: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadDashboard = useCallback(async (force = false) => {
    try {
      setLoading(true)
      setError(null)
      const response = await load({ force })
      setData({
        role: response.role,
        stats: response.stats,
        financialSummary: response.financialSummary,
        lowStock: response.lowStock,
        recentOrders: response.recentOrders,
        commercialSales: response.commercialSales,
        paidExpensesByDate: response.paidExpensesByDate,
        recentActivity: response.recentActivity,
        searchIndex: response.searchIndex,
      })
    } catch (err) {
      console.warn("DASHBOARD_LOAD_WARNING", getDashboardErrorDetails(err))
      setError("No se pudo cargar el dashboard.")
    } finally {
      setLoading(false)
    }
  }, [load])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  return {
    ...data,
    loading,
    error,
    reloadDashboard: () => loadDashboard(true),
  }
}
