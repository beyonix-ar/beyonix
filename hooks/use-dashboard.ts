"use client"

import { useCallback, useEffect, useState } from "react"

import {
  getDashboardData,
  type DashboardCommercialSale,
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
  lowStock: LowStockItem[]
  recentOrders: SupabasePedido[]
  commercialSales: DashboardCommercialSale[]
  recentActivity: DashboardRecentActivity[]
  systemStatus: DashboardSystemStatus[]
  searchIndex: DashboardSearchItem[]
}

export function useDashboard() {
  const [data, setData] = useState<DashboardState>({
    role: null,
    stats: null,
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
      console.error("DASHBOARD_LOAD_ERROR", {
        message: err && typeof err === "object" && "message" in err ? err.message : undefined,
        details: err && typeof err === "object" && "details" in err ? err.details : undefined,
        hint: err && typeof err === "object" && "hint" in err ? err.hint : undefined,
        code: err && typeof err === "object" && "code" in err ? err.code : undefined,
        error: err,
      })
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
