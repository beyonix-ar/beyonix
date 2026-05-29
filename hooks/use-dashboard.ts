"use client"

import { useCallback, useEffect, useState } from "react"

import {
  getDashboardData,
  type DashboardStats,
  type LowStockItem,
  type TopSellingProduct,
} from "@/lib/supabase/queries/dashboard"
import type { SupabasePedido, SupabaseProfile } from "@/lib/supabase/types"

interface DashboardState {
  stats: DashboardStats | null
  lowStock: LowStockItem[]
  recentOrders: SupabasePedido[]
  recentClients: SupabaseProfile[]
  topSellingProducts: TopSellingProduct[]
}

export function useDashboard() {
  const [data, setData] = useState<DashboardState>({
    stats: null,
    lowStock: [],
    recentOrders: [],
    recentClients: [],
    topSellingProducts: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadDashboard = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      setData(await getDashboardData())
    } catch (err) {
      console.error(err)
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
