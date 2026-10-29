import {
  parseSystemHealthResponse,
  type SystemHealthResponse,
} from "@/lib/admin/system-health"
import { supabase } from "@/lib/supabase/client"

import type { CommercialSale, PaidExpenseDay } from "@/lib/business/dashboard-commercial-ledger"
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

/** Línea comercial con la semántica única de commercial-sale-financials.ts. */
export type DashboardCommercialSale = CommercialSale

export interface DashboardRecentActivity {
  id: string
  type: "venta" | "pedido" | "pago" | "despacho"
  title: string
  detail: string
  meta?: string
  secondary?: string
  created_at: string
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

/**
 * Resumen histórico (todo el período). Mismas fórmulas que las líneas
 * comerciales: suma de commercialSales + gastos registrados.
 *   ventas netas      = bruto − reversiones − comisiones − logística − otros directos
 *   resultado comercial = ventas netas − costo de mercadería
 *   resultado estimado  = resultado comercial − gastos registrados pagados
 */
export interface DashboardFinancialSummary {
  webGrossSales: number
  marketplaceGrossSales: number
  externalGrossSales: number
  grossSales: number
  /** Reintegros/NC web, anulaciones ML y devoluciones externas dañadas. */
  completedRefunds: number
  pendingRefunds: number
  /** Ítems web recibidos en devolución sin NC todavía (ya restados del neto). */
  pendingReturnAdjustment: number
  /** Facturación ajustada: bruto − reversiones. */
  /** null: alguna venta tiene una reversión no atribuible (ver reversalAmbiguous). */
  billedSales: number | null
  netSales: number | null
  webNetSales: number | null
  marketplaceNet: number | null
  externalNet: number | null
  externalCollected: number
  customerCreditUsed: number
  shippingCharged: number
  shippingCost: number
  shippingBalance: number
  transferDiscounts: number
  webMercadoPagoFees: number
  marketplaceFees: number
  marketplaceRefunds: number
  marketplaceShipping: number
  salesFees: number
  /** Otros gastos directos de externas + ajustes del Total ML (negativo = a favor). */
  otherDirectCosts: number
  inventoryPurchases: number
  costOfGoodsSold: number
  contributionResult: number | null
  operatingExpensesPaid: number
  productExpenseEconomicCost: number
  operatingExpensesPending: number
  operatingResult: number | null
  operatingMarginPercent: number | null
  costCoveragePercent: number
  inferredCostPercent: number
  /** Pedidos web con factura autorizada (original_total): no es el neto fiscal. */
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
  externalRowsScanned: number
  complete: boolean
  generatedAt: string
  warnings: string[]
}

export interface DashboardDataResponse {
  role: "operador" | "admin" | "super_admin"
  stats: DashboardStats
  financialSummary: DashboardFinancialSummary
  lowStock: LowStockItem[]
  recentOrders: SupabasePedido[]
  commercialSales: DashboardCommercialSale[]
  /** Gastos pagados (y costo de gastos tipo producto) por día, para el resultado del período. */
  paidExpensesByDate: PaidExpenseDay[]
  recentActivity: DashboardRecentActivity[]
  searchIndex: DashboardSearchItem[]
}

let dashboardCache: {
  sessionKey: string
  data: DashboardDataResponse
  expiresAt: number
} | null = null

let dashboardRequest: {
  sessionKey: string
  promise: Promise<DashboardDataResponse>
} | null = null

export async function getDashboardData({
  force = false,
}: {
  force?: boolean
} = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error("La sesión administrativa venció.")
  }

  const sessionKey = session.access_token
  if (
    !force &&
    dashboardCache?.sessionKey === sessionKey &&
    dashboardCache.expiresAt > Date.now()
  ) {
    return dashboardCache.data
  }

  if (!force && dashboardRequest?.sessionKey === sessionKey) {
    return dashboardRequest.promise
  }

  const promise = (async () => {
    const response = await fetch(
      force ? "/api/admin/dashboard?refresh=1" : "/api/admin/dashboard",
      {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      cache: "no-store",
      },
    )
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

    const result = data as DashboardDataResponse
    dashboardCache = {
      sessionKey,
      data: result,
      expiresAt: Date.now() + 30_000,
    }
    return result
  })()

  dashboardRequest = {
    sessionKey,
    promise,
  }

  try {
    return await promise
  } finally {
    if (dashboardRequest?.promise === promise) {
      dashboardRequest = null
    }
  }
}

export async function getSystemHealth({
  force = false,
  signal,
}: {
  force?: boolean
  signal?: AbortSignal
} = {}): Promise<SystemHealthResponse> {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error("La sesión administrativa venció.")
  }

  const response = await fetch(
    force ? "/api/admin/system-health?force=1" : "/api/admin/system-health",
    {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      cache: "no-store",
      signal,
    },
  )
  const data: unknown = await response.json().catch(() => null)
  const health = response.ok ? parseSystemHealthResponse(data) : null

  if (!health) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Sin permisos para consultar el estado del sistema."
        : "No se pudo consultar el estado del sistema.",
    )
  }

  return health
}
