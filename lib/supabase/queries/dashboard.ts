import { supabase } from "@/lib/supabase/client"

import type { SupabasePedido } from "@/lib/supabase/types"

class DashboardDataError extends Error {
  status: number
  body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = "DashboardDataError"
    this.status = status
    this.body = body
  }
}

export interface LowStockItem {
  id: string
  nombre: string
  stock: number
  threshold: number
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
  type: "venta" | "pedido" | "pago" | "despacho"
  title: string
  detail: string
  meta?: string
  secondary?: string
  created_at: string
}

export interface DashboardSystemStatus {
  id: "store" | "mercadopago" | "andreani" | "arca"
  label: string
  status: "ok" | "warning" | "error" | "unknown"
  detail: string
}

export interface DashboardSearchItem {
  id: string
  type: "pedido" | "cliente" | "producto"
  title: string
  detail: string
  keywords: string
  section: "pedidos" | "clientes" | "productos"
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
  facturasPendientes: number
  pedidosPagados: number
  pedidosCancelados: number
  reintegrosPendientes: number
  facturasConError: number
  notasCreditoPendientes: number
  stockNegativo: number
}

export interface DashboardFinancialSummary {
  webGrossSales: number
  marketplaceGrossSales: number
  grossSales: number
  completedRefunds: number
  pendingRefunds: number
  netSales: number
  externalCollected: number
  customerCreditUsed: number
  shippingCharged: number
  shippingCost: number
  shippingBalance: number
  transferDiscounts: number
  marketplaceFees: number
  marketplaceShipping: number
  marketplaceNet: number
  inventoryPurchases: number
  costOfGoodsSold: number
  operatingExpensesPaid: number
  operatingExpensesPending: number
  knownOperatingResult: number
  trueProfit: number | null
  trueMarginPercent: number | null
  costCoveragePercent: number
  invoicedAmount: number
  paidOrders: number
  invoicedOrders: number
  ordersWithPaymentMismatch: number
  ordersMissingShippingCost: number
  ordersWithoutInvoice: number
  invoiceErrors: number
  creditNotesPending: number
  negativeStockItems: number
  ordersScanned: number
  marketplaceRowsScanned: number
  complete: boolean
  generatedAt: string
  warnings: string[]
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
  const text = await response.text()
  let data: unknown = null

  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
  }

  if (!response.ok) {
    const message =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : `No se pudo cargar el dashboard. HTTP ${response.status}`

    throw new DashboardDataError(message, response.status, data)
  }

  return data as {
    role: "operador" | "admin" | "super_admin"
    stats: DashboardStats
    financialSummary: DashboardFinancialSummary
    lowStock: LowStockItem[]
    recentOrders: SupabasePedido[]
    commercialSales: DashboardCommercialSale[]
    recentActivity: DashboardRecentActivity[]
    systemStatus: DashboardSystemStatus[]
    searchIndex: DashboardSearchItem[]
  }
}
