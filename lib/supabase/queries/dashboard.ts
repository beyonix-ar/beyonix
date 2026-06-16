import { supabase } from "@/lib/supabase/client"

import type { SupabasePedido } from "@/lib/supabase/types"

export interface LowStockItem {
  id: string
  nombre: string
  stock: number
  tipo: "producto" | "variante"
  producto_nombre?: string
  color_hex?: string
}

export interface DashboardCommercialSale {
  id: string
  date: string
  channel: "BEYONIX Web" | "MercadoLibre Marketplace"
  paymentMethod: string
  productName: string
  categoryName: string | null
  sku: string | null
  quantity: number
  grossAmount: number
  costAmount: number | null
  profitAmount: number | null
  marginPercent: number | null
  orderId: string | null
}

export interface DashboardRecentActivity {
  id: string
  type: "venta" | "pedido" | "pago" | "stock"
  title: string
  detail: string
  meta?: string
  secondary?: string
  created_at: string
}

export interface DashboardStats {
  totalProductos: number
  productosActivos: number
  productosInactivos: number
  productosBajoStock: number
  totalClientes: number | null
  totalOrdenes: number
  pedidosPendientes: number
  esperandoComprobante: number
  pagosEnRevision: number
  enviosPendientes: number
  pedidosSinTracking: number
  pedidosPagados: number
  pedidosCancelados: number
}

export async function getDashboardData() {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error("La sesión administrativa venció.")
  }

  const response = await fetch("/api/admin/dashboard", {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
    cache: "no-store",
  })
  const data = await response.json()

  if (!response.ok) {
    throw new Error(data.error ?? "No se pudo cargar el dashboard.")
  }

  return data as {
    role: "operador" | "admin" | "super_admin"
    stats: DashboardStats
    lowStock: LowStockItem[]
    recentOrders: SupabasePedido[]
    commercialSales: DashboardCommercialSale[]
    recentActivity: DashboardRecentActivity[]
  }
}
