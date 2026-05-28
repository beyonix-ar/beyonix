"use client"

import {
  useEffect,
  useState,
  useCallback,
} from "react"

import type {
  SupabasePedido,
  SupabaseProfile,
} from "@/lib/supabase/types"

import {
  getDashboardStats,
  getLowStockProducts,
  getRecentOrders,
  getRecentClients,
  getTotalRevenue,
  type LowStockItem,
  type DashboardStats,
} from "@/lib/supabase/queries/dashboard"

export function useDashboard() {
  const [stats, setStats] =
    useState<DashboardStats | null>(
      null
    )

  const [lowStock, setLowStock] =
    useState<LowStockItem[]>([])

  const [recentOrders, setRecentOrders] =
    useState<SupabasePedido[]>([])

  const [recentClients, setRecentClients] =
    useState<SupabaseProfile[]>([])

  const [revenue, setRevenue] =
    useState(0)

  const [loading, setLoading] =
    useState(true)

  const loadDashboard =
    useCallback(async () => {
      try {
        setLoading(true)

        const [
          statsData,
          lowStockData,
          ordersData,
          clientsData,
          revenueData,
        ] = await Promise.all([
          getDashboardStats(),
          getLowStockProducts(),
          getRecentOrders(),
          getRecentClients(),
          getTotalRevenue(),
        ])

        setStats(statsData)

        setLowStock(lowStockData)

        setRecentOrders(ordersData)

        setRecentClients(clientsData)

        setRevenue(revenueData)
      } catch (err) {
        console.error(err)
      } finally {
        setLoading(false)
      }
    }, [])

  useEffect(() => {
    loadDashboard()
  }, [loadDashboard])

  return {
    stats,
    lowStock,
    recentOrders,
    recentClients,
    revenue,
    loading,

    reloadDashboard:
      loadDashboard,
  }
}
