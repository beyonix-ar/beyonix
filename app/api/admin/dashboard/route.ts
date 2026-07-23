import { requireInternalUser } from "@/lib/auth/admin-api"
import { canViewSensitiveNumbers } from "@/lib/auth/roles"
import { getAndreaniConfig, isAndreaniReady } from "@/lib/andreani/client"
import { getWsfeHealth } from "@/lib/arca/wsfe"
import { getSiteSettings } from "@/lib/site-settings"
import type {
  SupabasePedido,
  SupabasePedidoItem,
  SupabaseProducto,
} from "@/lib/supabase/types"

const DISPATCHED_STATES = [
  "enviado",
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
  "entregado",
] as const
const PAID_STATES = new Set(["pagado", ...DISPATCHED_STATES, "approved"])
const PAYMENT_REVIEW_STATES = new Set(["pendiente_comprobante", "en_revision"])

interface DashboardLowStockItem {
  id: string
  nombre: string
  stock: number
  threshold: number
  tipo: "producto" | "variante"
  producto_nombre?: string
  color_hex?: string
}

interface CommercialSale {
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

interface RecentActivity {
  id: string
  type: "venta" | "pedido" | "pago" | "despacho"
  title: string
  detail: string
  meta?: string
  secondary?: string
  created_at: string
}

interface SystemStatusItem {
  id: "store" | "mercadopago" | "andreani" | "arca"
  label: string
  status: "ok" | "warning" | "error" | "unknown"
  detail: string
}

function isPaidOrder(order: SupabasePedido) {
  return PAID_STATES.has(order.estado) || order.payment_status === "approved"
}

function isReadyToPrepare(order: SupabasePedido) {
  return (
    isPaidOrder(order) &&
    ![...DISPATCHED_STATES, "cancelado"].includes(order.estado)
  )
}

interface DashboardFinancialSummary {
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

interface ProductCostRow {
  product_id: number
  variant_id: number | null
  purchase_date: string
  quantity: number
  total_cost: number
}

interface ExpenseRow {
  expense_date: string
  amount: number
  status: "pendiente" | "pagado"
}

interface CostLedgerPoint {
  date: number
  quantity: number
  cost: number
}

function buildCostLedgers(rows: ProductCostRow[]) {
  const grouped = new Map<string, ProductCostRow[]>()
  rows.forEach((row) => {
    const key = row.variant_id ? `v:${row.variant_id}` : `p:${row.product_id}`
    const values = grouped.get(key) ?? []
    values.push(row)
    grouped.set(key, values)
  })

  const ledgers = new Map<string, CostLedgerPoint[]>()
  grouped.forEach((values, key) => {
    let quantity = 0
    let cost = 0
    const points = values
      .sort((a, b) => a.purchase_date.localeCompare(b.purchase_date))
      .map((row) => {
        quantity += Number(row.quantity ?? 0)
        cost += Number(row.total_cost ?? 0)
        return {
          date: new Date(`${row.purchase_date}T00:00:00-03:00`).getTime(),
          quantity,
          cost,
        }
      })
    ledgers.set(key, points)
  })
  return ledgers
}

function getUnitCost(
  ledgers: Map<string, CostLedgerPoint[]>,
  productId: number,
  variantId: number | null | undefined,
  saleDate: string,
) {
  const timestamp = new Date(saleDate).getTime()
  const keys = variantId ? [`v:${variantId}`, `p:${productId}`] : [`p:${productId}`]

  for (const key of keys) {
    const points = ledgers.get(key)
    if (!points?.length) continue

    let low = 0
    let high = points.length - 1
    let match: CostLedgerPoint | null = null
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (points[middle].date <= timestamp) {
        match = points[middle]
        low = middle + 1
      } else {
        high = middle - 1
      }
    }

    if (match?.quantity) return match.cost / match.quantity
  }

  return null
}

function getPaymentMethodLabel(order: SupabasePedido | undefined) {
  if (!order) return "No informado"
  if (order.payment_method_id === "mercadopago" || order.payment_id) {
    return "Mercado Pago"
  }
  if (order.payment_method_id === "transferencia") {
    return "Transferencia"
  }
  return order.payment_method_id || order.payment_type_id || "No informado"
}

function getOrderCustomerLabel(order: SupabasePedido) {
  return order.cliente_nombre || order.cliente_email || "Cliente"
}

function getOrderItemName(item: SupabasePedidoItem) {
  const productName = item.productos?.nombre ?? `Producto #${item.producto_id}`
  const variantName = item.producto_variantes?.nombre

  return `${productName}${variantName ? ` ${variantName}` : ""}`
}

function getOrderItemLabel(item: SupabasePedidoItem) {
  const quantity = Number(item.cantidad ?? 1) || 1

  return `${getOrderItemName(item)} x${quantity}`
}

function groupItemsByOrder(items: SupabasePedidoItem[]) {
  return items.reduce((map, item) => {
    const rows = map.get(item.orden_id) ?? []
    rows.push(item)
    map.set(item.orden_id, rows)
    return map
  }, new Map<number, SupabasePedidoItem[]>())
}

async function getMercadoPagoStatus(): Promise<SystemStatusItem> {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN
  if (!token) {
    return {
      id: "mercadopago",
      label: "Mercado Pago",
      status: "unknown",
      detail: "Sin token configurado",
    }
  }

  try {
    const response = await fetch("https://api.mercadopago.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    })

    if (!response.ok) {
      return {
        id: "mercadopago",
        label: "Mercado Pago",
        status: "error",
        detail: `API respondió HTTP ${response.status}`,
      }
    }

    return {
      id: "mercadopago",
      label: "Mercado Pago",
      status: "ok",
      detail: "API accesible con credenciales",
    }
  } catch {
    return {
      id: "mercadopago",
      label: "Mercado Pago",
      status: "error",
      detail: "No se pudo verificar la API",
    }
  }
}

async function withFallback<T>(
  promise: PromiseLike<T>,
  fallback: T,
  label: string
) {
  try {
    return await promise
  } catch (error) {
    console.warn(`DASHBOARD_${label}_FALLBACK`, getErrorLogDetails(error))
    return fallback
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  fallback: T,
  ms: number,
  label: string
) {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      }),
    ])
  } catch (error) {
    console.warn(`DASHBOARD_${label}_TIMEOUT_FALLBACK`, getErrorLogDetails(error))
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function getErrorLogDetails(error: unknown) {
  if (!error || typeof error !== "object") {
    return {
      message: String(error),
      details: null,
      hint: null,
      code: null,
    }
  }

  const candidate = error as {
    message?: unknown
    details?: unknown
    hint?: unknown
    code?: unknown
    status?: unknown
    statusText?: unknown
  }

  return {
    message:
      typeof candidate.message === "string"
        ? candidate.message
        : JSON.stringify(error),
    details: candidate.details ?? null,
    hint: candidate.hint ?? null,
    code: candidate.code ?? null,
    status: candidate.status ?? null,
    statusText: candidate.statusText ?? null,
  }
}

interface SafeDashboardQueryResult {
  data: unknown
  error: unknown
  count: number | null
  status: number
  statusText: string
}

async function safeDashboardQuery(
  name: string,
  query: PromiseLike<SafeDashboardQueryResult>,
  fallback: SafeDashboardQueryResult
) {
  try {
    const result = await query

    if (result.error) {
      console.warn(`DASHBOARD_QUERY_FALLBACK:${name}`, {
        query: name,
        ...getErrorLogDetails(result.error),
      })

      return fallback
    }

    return result
  } catch (error) {
    console.warn(`DASHBOARD_QUERY_THROWN:${name}`, {
      query: name,
      ...getErrorLogDetails(error),
    })

    return fallback
  }
}

const DASHBOARD_PAGE_SIZE = 1000
const DASHBOARD_MAX_PAGES = 100

async function fetchAllDashboardRows<T>(
  name: string,
  getPage: (
    from: number,
    to: number,
  ) => PromiseLike<SafeDashboardQueryResult>,
) {
  const rows: T[] = []
  let complete = true

  for (let page = 0; page < DASHBOARD_MAX_PAGES; page += 1) {
    const from = page * DASHBOARD_PAGE_SIZE
    const result = await safeDashboardQuery(
      `${name}_pagina_${page + 1}`,
      getPage(from, from + DASHBOARD_PAGE_SIZE - 1),
      { ...EMPTY_ROWS_RESULT, statusText: "FALLBACK" },
    )

    if (result.statusText === "FALLBACK") {
      complete = false
      break
    }

    const pageRows = (result.data ?? []) as T[]
    rows.push(...pageRows)

    if (pageRows.length < DASHBOARD_PAGE_SIZE) break
    if (page === DASHBOARD_MAX_PAGES - 1) complete = false
  }

  return { rows, complete }
}

function getCount(result: { count: number | null } | null | undefined) {
  return result?.count ?? 0
}

const EMPTY_ROWS_RESULT = {
  data: [],
  error: null,
  count: 0,
  status: 200,
  statusText: "OK",
}

const EMPTY_COUNT_RESULT = {
  data: null,
  error: null,
  count: 0,
  status: 200,
  statusText: "OK",
}

const ORDER_SELECT = `
  id,
  estado,
  total,
  cliente_nombre,
  cliente_email,
  cliente_username,
  payment_id,
  payment_status,
  payment_method_id,
  payment_type_id,
  payment_proof_url,
  payment_proof_file_name,
  payment_proof_uploaded_at,
  paid_at,
  tracking_number,
  tracking_url,
  andreani_tracking,
  andreani_etiqueta_url,
  shipping_cost_real,
  shipping_cost_charged,
  transfer_discount_amount,
  invoice_status,
  created_at
`

const PRODUCT_SEARCH_SELECT = `
  id,
  nombre,
  slug,
  activo,
  stock,
  categorias(nombre),
  producto_variantes(id, nombre, stock, activo, color_hex)
`

const ORDER_ITEM_SELECT = `
  id,
  orden_id,
  producto_id,
  variante_id,
  cantidad,
  precio,
  productos(id, nombre, categorias(nombre)),
  producto_variantes(nombre)
`

const FINANCIAL_ORDER_SELECT = `
  id,
  estado,
  total,
  original_total,
  credit_balance_used,
  external_amount_due,
  payment_status,
  payment_method_id,
  paid_at,
  financial_status,
  payment_confirmed_amount,
  payment_confirmed_at,
  refund_amount,
  refund_pending_at,
  refunded_at,
  shipping_provider,
  envio_proveedor,
  shipping_cost_real,
  shipping_cost_charged,
  andreani_costo,
  transfer_discount_amount,
  invoice_status,
  invoice_created_at,
  credit_note_required,
  credit_note_status,
  credit_note_amount,
  created_at
`

function getAndreaniStatus(): SystemStatusItem {
  const config = getAndreaniConfig()
  if (!config.enabled) {
    return {
      id: "andreani",
      label: "Andreani",
      status: "unknown",
      detail: "Integración deshabilitada",
    }
  }

  const ready = isAndreaniReady(config)

  return {
    id: "andreani",
    label: "Andreani",
    status: ready ? "unknown" : "warning",
    detail: ready
      ? "Configurado, sin health check real implementado"
      : "Configuración incompleta",
  }
}

async function getArcaStatus(): Promise<SystemStatusItem> {
  try {
    const health = await getWsfeHealth()
    const values = [health.appServer, health.dbServer, health.authServer]
    const allOk = values.every((value) => value === "OK")

    return {
      id: "arca",
      label: "ARCA / Facturación electrónica",
      status: allOk ? "ok" : "warning",
      detail: allOk
        ? "WSFEv1 FEDummy respondió OK"
        : `FEDummy: app ${health.appServer || "-"}, db ${health.dbServer || "-"}, auth ${health.authServer || "-"}`,
    }
  } catch {
    return {
      id: "arca",
      label: "ARCA / Facturación electrónica",
      status: "unknown",
      detail: "No verificable en este momento",
    }
  }
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth.error

  const sensitive = canViewSensitiveNumbers(auth.profile.rol)
  const { stock: stockSettings } = await getSiteSettings()
  const paidOrderFilter =
    "estado.in.(pagado,enviado,en_camino,visita_fallida,en_sucursal,retiro_pendiente,retiro_vencido,en_devolucion,devuelto_beyonix,entregado,approved),payment_status.eq.approved"

  const [
    productsCountResult,
    activeProductsCountResult,
    inactiveProductsCountResult,
    clientsCountResult,
    totalOrdersCountResult,
    recentOrdersResult,
    pendingOrdersCountResult,
    paymentReviewCountResult,
    waitingProofCountResult,
    paidOrdersCountResult,
    cancelledOrdersCountResult,
    pendingDispatchResult,
    pendingInvoiceResult,
    lowStockProductsResult,
    lowStockVariantsResult,
    searchProductsResult,
    searchOrdersResult,
    searchClientsResult,
    mercadoLibreResult,
    mercadoPagoStatus,
    arcaStatus,
  ] = await Promise.all([
    safeDashboardQuery(
      "productos_total_count",
      auth.admin.from("productos").select("id", { count: "exact", head: true }),
      EMPTY_COUNT_RESULT
    ),
    safeDashboardQuery(
      "productos_activos_count",
      auth.admin
        .from("productos")
        .select("id", { count: "exact", head: true })
        .eq("activo", true),
      EMPTY_COUNT_RESULT
    ),
    safeDashboardQuery(
      "productos_inactivos_count",
      auth.admin
        .from("productos")
        .select("id", { count: "exact", head: true })
        .eq("activo", false),
      EMPTY_COUNT_RESULT
    ),
    safeDashboardQuery(
      "clientes_total_count",
      auth.admin
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("rol", "cliente"),
      EMPTY_COUNT_RESULT,
    ),
    safeDashboardQuery(
      "ordenes_total_count",
      auth.admin.from("ordenes").select("id", { count: "exact", head: true }),
      EMPTY_COUNT_RESULT
    ),
    safeDashboardQuery(
      "ordenes_recientes",
      auth.admin
        .from("ordenes")
        .select(ORDER_SELECT)
        .order("created_at", { ascending: false })
        .limit(8),
      EMPTY_ROWS_RESULT
    ),
    safeDashboardQuery(
      "ordenes_pendientes_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .eq("estado", "pendiente"),
      EMPTY_COUNT_RESULT
    ),
    safeDashboardQuery(
      "pagos_en_revision_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .in("payment_status", [...PAYMENT_REVIEW_STATES]),
      EMPTY_COUNT_RESULT
    ),
    safeDashboardQuery(
      "esperando_comprobante_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .eq("payment_method_id", "transferencia")
        .is("payment_proof_url", null)
        .not("payment_status", "in", "(confirmado,approved,rechazado)"),
      EMPTY_COUNT_RESULT
    ),
    safeDashboardQuery(
      "ordenes_pagadas_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .or(paidOrderFilter),
      EMPTY_COUNT_RESULT
    ),
    safeDashboardQuery(
      "ordenes_canceladas_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .eq("estado", "cancelado"),
      EMPTY_COUNT_RESULT
    ),
    safeDashboardQuery(
      "pedidos_a_preparar",
      auth.admin
        .from("ordenes")
        .select(ORDER_SELECT)
        .or(paidOrderFilter)
        .not("estado", "in", "(enviado,en_camino,visita_fallida,en_sucursal,retiro_pendiente,retiro_vencido,en_devolucion,devuelto_beyonix,entregado,cancelado)")
        .order("created_at", { ascending: false })
        .limit(50),
      EMPTY_ROWS_RESULT
    ),
    safeDashboardQuery(
      "facturas_pendientes",
      auth.admin
        .from("ordenes")
        .select(ORDER_SELECT)
        .or(paidOrderFilter)
        .or("invoice_status.is.null,invoice_status.neq.authorized")
        .order("created_at", { ascending: false })
        .limit(50),
      EMPTY_ROWS_RESULT
    ),
    safeDashboardQuery(
      "productos_bajo_stock",
      auth.admin
        .from("productos")
        .select("id, nombre, stock, activo, producto_variantes(id, activo)")
        .eq("activo", true)
        .lte("stock", stockSettings.lowStockThreshold)
        .order("stock", { ascending: true })
        .limit(100),
      EMPTY_ROWS_RESULT
    ),
    safeDashboardQuery(
      "variantes_bajo_stock",
      auth.admin
        .from("producto_variantes")
        .select("id, producto_id, nombre, stock, activo, color_hex, productos(nombre)")
        .eq("activo", true)
        .lte("stock", stockSettings.lowStockThreshold)
        .order("stock", { ascending: true })
        .limit(100),
      EMPTY_ROWS_RESULT
    ),
    safeDashboardQuery(
      "productos_busqueda",
      auth.admin
        .from("productos")
        .select(PRODUCT_SEARCH_SELECT)
        .order("id", { ascending: false })
        .limit(80),
      EMPTY_ROWS_RESULT
    ),
    safeDashboardQuery(
      "ordenes_busqueda",
      auth.admin
        .from("ordenes")
        .select(ORDER_SELECT)
        .order("created_at", { ascending: false })
        .limit(150),
      EMPTY_ROWS_RESULT
    ),
    safeDashboardQuery(
      "clientes_busqueda",
      auth.admin
        .from("profiles")
        .select("id, nombre, email, username, telefono, dni")
        .eq("rol", "cliente")
        .order("created_at", { ascending: false })
        .limit(150),
      EMPTY_ROWS_RESULT
    ),
    safeDashboardQuery(
      "mercadolibre_sales_recientes",
      auth.admin
        .from("mercadolibre_sales")
        .select("id, sale_date, imported_at, order_id, product_name, sku, quantity, gross_amount, fee_amount, shipping_amount, net_amount")
        .order("sale_date", { ascending: false })
        .limit(sensitive ? 250 : 25),
      EMPTY_ROWS_RESULT
    ),
    withTimeout(
      getMercadoPagoStatus(),
      {
        id: "mercadopago",
        label: "Mercado Pago",
        status: "unknown",
        detail: "Sin datos en este momento",
      },
      3000,
      "MERCADOPAGO"
    ),
    withTimeout(
      getArcaStatus(),
      {
        id: "arca",
        label: "ARCA / Facturación electrónica",
        status: "unknown",
        detail: "Sin datos en este momento",
      },
      3000,
      "ARCA"
    ),
  ])

  const [
    financialOrdersScan,
    orderItemsScan,
    marketplaceScan,
    negativeProductsResult,
    negativeVariantsResult,
    pendingDispatchCountResult,
    pendingInvoiceCountResult,
    pendingRefundCountResult,
    invoiceErrorCountResult,
    creditNotePendingCountResult,
    productCostsScan,
    expensesScan,
  ] = await Promise.all([
    sensitive
      ? fetchAllDashboardRows<SupabasePedido>(
          "ordenes_financieras",
          (from, to) =>
            auth.admin
              .from("ordenes")
              .select(FINANCIAL_ORDER_SELECT)
              .order("id", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({ rows: [] as SupabasePedido[], complete: true }),
    sensitive
      ? fetchAllDashboardRows<SupabasePedidoItem>(
          "items_comerciales",
          (from, to) =>
            auth.admin
              .from("orden_items")
              .select(ORDER_ITEM_SELECT)
              .order("id", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({ rows: [] as SupabasePedidoItem[], complete: true }),
    sensitive
      ? fetchAllDashboardRows<Record<string, unknown>>(
          "ventas_mercadolibre",
          (from, to) =>
            auth.admin
              .from("mercadolibre_sales")
              .select("id, sale_date, imported_at, order_id, product_name, sku, quantity, gross_amount, fee_amount, shipping_amount, net_amount")
              .order("id", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({
          rows: (mercadoLibreResult.data ?? []) as Array<Record<string, unknown>>,
          complete: true,
        }),
    safeDashboardQuery(
      "productos_stock_negativo",
      auth.admin
        .from("productos")
        .select("id", { count: "exact", head: true })
        .lt("stock", 0),
      EMPTY_COUNT_RESULT,
    ),
    safeDashboardQuery(
      "variantes_stock_negativo",
      auth.admin
        .from("producto_variantes")
        .select("id", { count: "exact", head: true })
        .lt("stock", 0),
      EMPTY_COUNT_RESULT,
    ),
    safeDashboardQuery(
      "pedidos_a_preparar_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .or(paidOrderFilter)
        .not("estado", "in", "(enviado,en_camino,visita_fallida,en_sucursal,retiro_pendiente,retiro_vencido,en_devolucion,devuelto_beyonix,entregado,cancelado)"),
      EMPTY_COUNT_RESULT,
    ),
    safeDashboardQuery(
      "facturas_pendientes_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .or(paidOrderFilter)
        .or("invoice_status.is.null,invoice_status.neq.authorized"),
      EMPTY_COUNT_RESULT,
    ),
    safeDashboardQuery(
      "reintegros_pendientes_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .eq("financial_status", "refund_pending"),
      EMPTY_COUNT_RESULT,
    ),
    safeDashboardQuery(
      "facturas_error_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .eq("invoice_status", "error"),
      EMPTY_COUNT_RESULT,
    ),
    safeDashboardQuery(
      "notas_credito_pendientes_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .eq("credit_note_required", true)
        .or("credit_note_status.is.null,credit_note_status.neq.authorized"),
      EMPTY_COUNT_RESULT,
    ),
    sensitive
      ? fetchAllDashboardRows<ProductCostRow>(
          "costos_producto",
          (from, to) =>
            auth.admin
              .from("product_cost_entries")
              .select("product_id, variant_id, purchase_date, quantity, total_cost")
              .order("purchase_date", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({ rows: [] as ProductCostRow[], complete: true }),
    sensitive
      ? fetchAllDashboardRows<ExpenseRow>(
          "gastos_negocio",
          (from, to) =>
            auth.admin
              .from("business_expenses")
              .select("expense_date, amount, status")
              .order("expense_date", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({ rows: [] as ExpenseRow[], complete: true }),
  ])

  const recentOrders = (recentOrdersResult.data ?? []) as SupabasePedido[]
  const pendingDispatchOrders = (pendingDispatchResult.data ?? []) as SupabasePedido[]
  const pendingInvoiceOrders = (pendingInvoiceResult.data ?? []) as SupabasePedido[]
  const products = (searchProductsResult.data ?? []) as unknown as SupabaseProducto[]
  const mlRows = marketplaceScan.rows
  const financialOrders = financialOrdersScan.rows
  const paidCandidateOrders = sensitive
    ? financialOrders.filter(isPaidOrder)
    : [
        ...recentOrders.filter(isPaidOrder),
        ...pendingDispatchOrders,
        ...pendingInvoiceOrders,
      ]
  const paidOrderIds = new Set(paidCandidateOrders.map((order) => order.id))
  const paidOrdersById = new Map(
    paidCandidateOrders.map((order) => [order.id, order] as const),
  )
  const items = orderItemsScan.rows.filter((item) => paidOrderIds.has(item.orden_id))
  const itemsByOrderId = groupItemsByOrder(items)
  const webOrdersWithoutItems = paidCandidateOrders.filter(
    (order) => !itemsByOrderId.has(order.id),
  )
  const costLedgers = buildCostLedgers(productCostsScan.rows)
  const itemUnitCosts = new Map<number, number | null>()
  let coveredUnits = 0
  let webUnits = 0
  let costOfGoodsSold = 0
  items.forEach((item) => {
    const quantity = Math.max(Number(item.cantidad ?? 0), 0)
    const order = paidOrdersById.get(item.orden_id)
    const unitCost = getUnitCost(
      costLedgers,
      item.producto_id,
      item.variante_id,
      order?.paid_at ?? order?.created_at ?? new Date().toISOString(),
    )
    webUnits += quantity
    if (unitCost != null) {
      coveredUnits += quantity
      costOfGoodsSold += unitCost * quantity
    }
    itemUnitCosts.set(item.id, unitCost)
  })
  const marketplaceUnits = mlRows.reduce(
    (total, row) => total + Math.max(Number(row.quantity ?? 0), 0),
    0,
  )
  const totalCostableUnits = webUnits + marketplaceUnits
  const costCoveragePercent = totalCostableUnits > 0
    ? (coveredUnits / totalCostableUnits) * 100
    : 100
  const inventoryPurchases = productCostsScan.rows.reduce(
    (total, row) => total + Number(row.total_cost ?? 0),
    0,
  )
  const operatingExpensesPaid = expensesScan.rows.reduce(
    (total, row) => total + (row.status === "pagado" ? Number(row.amount ?? 0) : 0),
    0,
  )
  const operatingExpensesPending = expensesScan.rows.reduce(
    (total, row) => total + (row.status === "pendiente" ? Number(row.amount ?? 0) : 0),
    0,
  )
  const lowStockProducts = ((lowStockProductsResult.data ?? []) as Array<{
        id: number
        nombre: string
        stock: number | null
        producto_variantes?: Array<{
          id: number
          activo: boolean | null
        }> | null
      }>)
    .filter(
      (product) =>
        !(product.producto_variantes ?? []).some(
          (variant) => variant.activo !== false,
        ),
    )
    .map((product) => ({
        id: `producto-${product.id}`,
        nombre: product.nombre,
        stock: product.stock ?? 0,
        threshold: stockSettings.lowStockThreshold,
        tipo: "producto" as const,
      }))
  const lowStockVariants = ((lowStockVariantsResult.data ?? []) as Array<{
        id: number
        producto_id: number
        nombre: string
        stock: number | null
        color_hex?: string | null
        productos?: { nombre?: string | null } | null
      }>).map((variant) => ({
        id: `variante-${variant.id}`,
        nombre: variant.nombre,
        producto_nombre: variant.productos?.nombre ?? "Producto",
        stock: variant.stock ?? 0,
        threshold: stockSettings.lowStockThreshold,
        tipo: "variante" as const,
        color_hex: variant.color_hex ?? undefined,
      }))
  const lowStock = [...lowStockProducts, ...lowStockVariants]
  const sortedLowStock = [...lowStock].sort((a, b) => a.stock - b.stock)
  const negativeStockItems =
    getCount(negativeProductsResult) + getCount(negativeVariantsResult)
  const webGrossSales = paidCandidateOrders.reduce(
    (total, order) =>
      total + Number(order.original_total ?? order.total ?? 0),
    0,
  )
  const completedRefunds = paidCandidateOrders.reduce(
    (total, order) =>
      total +
      (order.financial_status === "refunded" || order.refunded_at
        ? Number(order.refund_amount ?? order.total ?? 0)
        : 0),
    0,
  )
  const pendingRefundOrders = paidCandidateOrders.filter(
    (order) => order.financial_status === "refund_pending",
  )
  const pendingRefunds = pendingRefundOrders.reduce(
    (total, order) => total + Number(order.refund_amount ?? order.total ?? 0),
    0,
  )
  const externalCollected = paidCandidateOrders.reduce(
    (total, order) =>
      total +
      Number(
        order.external_amount_due ??
          order.payment_confirmed_amount ??
          Math.max(
            Number(order.total ?? 0) - Number(order.credit_balance_used ?? 0),
            0,
          ),
      ),
    0,
  )
  const customerCreditUsed = paidCandidateOrders.reduce(
    (total, order) => total + Number(order.credit_balance_used ?? 0),
    0,
  )
  const shippingCharged = paidCandidateOrders.reduce(
    (total, order) => total + Number(order.shipping_cost_charged ?? 0),
    0,
  )
  const shippingCost = paidCandidateOrders.reduce(
    (total, order) =>
      total + Number(order.shipping_cost_real ?? order.andreani_costo ?? 0),
    0,
  )
  const transferDiscounts = paidCandidateOrders.reduce(
    (total, order) => total + Number(order.transfer_discount_amount ?? 0),
    0,
  )
  const marketplaceGrossSales = mlRows.reduce(
    (total, row) => total + Number(row.gross_amount ?? 0),
    0,
  )
  const marketplaceFees = mlRows.reduce(
    (total, row) => total + Number(row.fee_amount ?? 0),
    0,
  )
  const marketplaceShipping = mlRows.reduce(
    (total, row) => total + Number(row.shipping_amount ?? 0),
    0,
  )
  const marketplaceNet = mlRows.reduce((total, row) => {
    const gross = Number(row.gross_amount ?? 0)
    const fee = Number(row.fee_amount ?? 0)
    const shipping = Number(row.shipping_amount ?? 0)
    const storedNet = row.net_amount

    return total + Number(storedNet ?? gross - fee - shipping)
  }, 0)
  const invoicedOrders = paidCandidateOrders.filter(
    (order) => order.invoice_status === "authorized",
  )
  const ordersWithPaymentMismatch = paidCandidateOrders.filter((order) => {
    if (order.payment_confirmed_amount == null) return false

    const expected = Number(order.external_amount_due ?? order.total ?? 0)
    return Math.abs(Number(order.payment_confirmed_amount) - expected) > 0.01
  }).length
  const ordersMissingShippingCost = paidCandidateOrders.filter(
    (order) =>
      Boolean(order.shipping_provider || order.envio_proveedor) &&
      order.shipping_cost_real == null &&
      order.andreani_costo == null,
  ).length
  const invoiceErrors = paidCandidateOrders.filter(
    (order) => order.invoice_status === "error",
  ).length
  const creditNotesPending = paidCandidateOrders.filter(
    (order) =>
      order.credit_note_required && order.credit_note_status !== "authorized",
  ).length
  const scanComplete =
    financialOrdersScan.complete &&
    orderItemsScan.complete &&
    marketplaceScan.complete &&
    productCostsScan.complete &&
    expensesScan.complete
  const knownOperatingResult =
    webGrossSales - completedRefunds - shippingCost + marketplaceNet
  const hasFullCostCoverage =
    scanComplete &&
    webOrdersWithoutItems.length === 0 &&
    costCoveragePercent >= 99.999
  const trueProfit = hasFullCostCoverage
    ? knownOperatingResult - costOfGoodsSold - operatingExpensesPaid
    : null
  const financialWarnings = [
    ...(!scanComplete
      ? ["La lectura histórica o las tablas de costos están incompletas. Aplicá la migración pendiente y revisá el servidor."]
      : []),
    ...(costCoveragePercent < 99.999
      ? [`Los costos cubren el ${costCoveragePercent.toFixed(1)}% de las unidades vendidas. Completá las compras faltantes para obtener rentabilidad exacta.`]
      : []),
    ...(webOrdersWithoutItems.length > 0
      ? [`${webOrdersWithoutItems.length} pedidos pagos no tienen detalle de artículos y no pueden costearse.`]
      : []),
    ...(expensesScan.rows.length === 0
      ? ["No hay gastos generales registrados; el resultado actual considera gastos operativos por $0."]
      : []),
    ...(operatingExpensesPending > 0
      ? [`Hay ${operatingExpensesPending.toLocaleString("es-AR", { style: "currency", currency: "ARS" })} en gastos pendientes de pago.`]
      : []),
    ...(ordersMissingShippingCost > 0
      ? [`${ordersMissingShippingCost} pedidos pagos no tienen costo logístico real registrado.`]
      : []),
    ...(ordersWithPaymentMismatch > 0
      ? [`${ordersWithPaymentMismatch} cobros confirmados no coinciden con el importe externo esperado.`]
      : []),
    ...(invoiceErrors > 0
      ? [`${invoiceErrors} facturas tienen error y requieren revisión.`]
      : []),
    ...(creditNotesPending > 0
      ? [`${creditNotesPending} notas de crédito requeridas todavía no están autorizadas.`]
      : []),
    ...(negativeStockItems > 0
      ? [`${negativeStockItems} productos o variantes tienen stock negativo.`]
      : []),
  ]
  const financialSummary: DashboardFinancialSummary = {
    webGrossSales,
    marketplaceGrossSales,
    grossSales: webGrossSales + marketplaceGrossSales,
    completedRefunds,
    pendingRefunds,
    netSales: webGrossSales + marketplaceGrossSales - completedRefunds,
    externalCollected,
    customerCreditUsed,
    shippingCharged,
    shippingCost,
    shippingBalance: shippingCharged - shippingCost,
    transferDiscounts,
    marketplaceFees,
    marketplaceShipping,
    marketplaceNet,
    inventoryPurchases,
    costOfGoodsSold,
    operatingExpensesPaid,
    operatingExpensesPending,
    knownOperatingResult,
    trueProfit,
    trueMarginPercent:
      trueProfit != null && webGrossSales + marketplaceGrossSales > 0
        ? (trueProfit / (webGrossSales + marketplaceGrossSales)) * 100
        : null,
    costCoveragePercent,
    invoicedAmount: invoicedOrders.reduce(
      (total, order) => total + Number(order.original_total ?? order.total ?? 0),
      0,
    ),
    paidOrders: paidCandidateOrders.length,
    invoicedOrders: invoicedOrders.length,
    ordersWithPaymentMismatch,
    ordersMissingShippingCost,
    ordersWithoutInvoice: paidCandidateOrders.length - invoicedOrders.length,
    invoiceErrors,
    creditNotesPending,
    negativeStockItems,
    ordersScanned: financialOrders.length,
    marketplaceRowsScanned: mlRows.length,
    complete: scanComplete,
    generatedAt: new Date().toISOString(),
    warnings: financialWarnings,
  }
  const webItemTotalsByOrder = items.reduce((totals, item) => {
    totals.set(
      item.orden_id,
      (totals.get(item.orden_id) ?? 0) +
        Number(item.cantidad ?? 0) * Number(item.precio ?? 0),
    )
    return totals
  }, new Map<number, number>())
  const commercialSales: CommercialSale[] = sensitive
    ? [
        ...items
          .map((item) => {
            const order = paidOrdersById.get(item.orden_id)
            const product = item.productos as
              | (SupabaseProducto & { categorias?: { nombre?: string | null } })
              | null
              | undefined
            const quantity = Number(item.cantidad ?? 0)
            const rawItemAmount = quantity * Number(item.precio ?? 0)
            const rawOrderAmount = webItemTotalsByOrder.get(item.orden_id) ?? 0
            const orderGrossAmount = Number(
              order?.original_total ?? order?.total ?? rawOrderAmount,
            )
            const grossAmount =
              rawOrderAmount > 0
                ? (rawItemAmount / rawOrderAmount) * orderGrossAmount
                : rawItemAmount
            const unitCost = itemUnitCosts.get(item.id) ?? null
            const costAmount = unitCost == null ? null : unitCost * quantity
            const profitAmount = costAmount == null ? null : grossAmount - costAmount

            return {
              id: `web-${item.id}`,
              date: order?.paid_at ?? order?.created_at ?? new Date().toISOString(),
              channel: "BEYONIX Web" as const,
              paymentMethod: getPaymentMethodLabel(order),
              productName: product?.nombre ?? `Producto #${item.producto_id}`,
              categoryName: product?.categorias?.nombre ?? null,
              sku: null,
              quantity,
              grossAmount,
              costAmount,
              profitAmount,
              marginPercent:
                profitAmount != null && grossAmount > 0
                  ? (profitAmount / grossAmount) * 100
                  : null,
              orderId: order ? String(order.id) : null,
            }
          }),
        ...webOrdersWithoutItems.map((order) => ({
          id: `web-order-${order.id}`,
          date: order.paid_at ?? order.created_at,
          channel: "BEYONIX Web" as const,
          paymentMethod: getPaymentMethodLabel(order),
          productName: `Pedido #${order.id} sin detalle`,
          categoryName: null,
          sku: null,
          quantity: 0,
          grossAmount: Number(order.original_total ?? order.total ?? 0),
          costAmount: null,
          profitAmount: null,
          marginPercent: null,
          orderId: String(order.id),
        })),
        ...mlRows.map((row) => {
          const quantity = Number(row.quantity ?? 0)
          const grossAmount = Number(row.gross_amount ?? 0)
          const netAmount = Number(row.net_amount ?? grossAmount)
          const feeAmount = Number(row.fee_amount ?? 0)
          const shippingAmount = Number(row.shipping_amount ?? 0)
          const profitAmount =
            row.net_amount != null || feeAmount || shippingAmount
              ? row.net_amount != null
                ? netAmount
                : grossAmount - feeAmount - shippingAmount
              : null

          return {
            id: `ml-${String(row.id)}`,
            date: String(
              row.sale_date ?? row.imported_at ?? new Date().toISOString(),
            ),
            channel: "MercadoLibre Marketplace" as const,
            paymentMethod: "MercadoLibre",
            productName: String(row.product_name ?? "Venta MercadoLibre"),
            categoryName: null,
            sku: row.sku ? String(row.sku) : null,
            quantity,
            grossAmount,
            costAmount: null,
            profitAmount,
            marginPercent:
              profitAmount !== null && grossAmount > 0
                ? (profitAmount / grossAmount) * 100
                : null,
            orderId: row.order_id ? String(row.order_id) : null,
          }
        }),
      ]
    : []
  const recentWebSales: RecentActivity[] = recentOrders.filter(isPaidOrder).map((order) => {
    const orderItems = itemsByOrderId.get(order.id) ?? []
    const firstItem = orderItems[0]
    const additionalItems = Math.max(0, orderItems.length - 1)

    return {
      id: `venta-web-${order.id}`,
      type: "venta",
      title: "Nueva venta realizada",
      detail: firstItem
        ? `${getOrderItemLabel(firstItem)}${additionalItems ? ` y ${additionalItems} más` : ""}`
        : `Orden #${order.id}`,
      meta: getPaymentMethodLabel(order),
      secondary: `Orden #${order.id}`,
      created_at: order.paid_at || order.created_at,
    }
  })
  const recentMercadoLibreSales: RecentActivity[] = mlRows
    .slice(0, 10)
    .map((row) => ({
      id: `venta-ml-${String(row.id)}`,
      type: "venta",
      title: "Nueva venta realizada",
      detail: `${String(row.product_name ?? "Venta MercadoLibre")} x${Number(row.quantity ?? 1) || 1}`,
      meta: "MercadoLibre",
      secondary: row.order_id ? `Orden #${String(row.order_id)}` : "Marketplace",
      created_at: String(
        row.sale_date ?? row.imported_at ?? new Date().toISOString(),
      ),
    }))
  const paymentConfirmedActivity: RecentActivity[] = recentOrders.filter(isPaidOrder)
    .slice(0, 8)
    .map((order) => ({
      id: `pago-confirmado-${order.id}`,
      type: "pago",
      title: "Pago confirmado",
      detail: `Orden #${order.id}`,
      meta: `${getPaymentMethodLabel(order)} aprobado`,
      created_at: order.paid_at || order.created_at,
    }))
  const recentActivity: RecentActivity[] = [
    ...recentWebSales,
    ...recentMercadoLibreSales,
    ...paymentConfirmedActivity,
    ...pendingDispatchOrders.slice(0, 5).map((order) => ({
      id: `despacho-${order.id}`,
      type: "despacho" as const,
      title: "Pedido listo para despacho",
      detail: `Orden #${order.id}`,
      meta: getOrderCustomerLabel(order),
      created_at: order.paid_at || order.created_at,
    })),
    ...recentOrders
      .filter((order) => !isPaidOrder(order))
      .slice(0, 5)
      .map((order) => ({
        id: `pedido-${order.id}`,
        type: "pedido" as const,
        title: "Cambio de estado de pedido",
        detail: `Orden #${order.id}`,
        meta: `${getOrderCustomerLabel(order)} · ${order.estado}`,
        created_at: order.created_at,
      })),
    ...recentOrders.filter((order) => PAYMENT_REVIEW_STATES.has(order.payment_status ?? "")).slice(0, 5).map((order) => ({
      id: `pago-${order.id}`,
      type: "pago" as const,
      title: "Pago en revisión",
      detail: `Orden #${order.id}`,
      meta: order.payment_proof_file_name
        ? "Comprobante recibido"
        : "Transferencia pendiente",
      created_at: order.payment_proof_uploaded_at || order.created_at,
    })),
  ]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, 10)
  const systemStatus: SystemStatusItem[] = [
    {
      id: "store",
      label: "Tienda activa",
      status: "ok",
      detail: "Base de datos accesible",
    },
    mercadoPagoStatus as SystemStatusItem,
    getAndreaniStatus(),
    arcaStatus as SystemStatusItem,
  ]
  const searchOrders = (searchOrdersResult.data ?? []) as unknown as SupabasePedido[]
  const searchClients = (searchClientsResult.data ?? []) as Array<{
    id: string
    nombre?: string | null
    email?: string | null
    username?: string | null
    telefono?: string | null
    dni?: string | null
  }>
  const searchIndex = [
    ...searchOrders.map((order) => {
      const orderItems = itemsByOrderId.get(order.id) ?? []

      return {
        id: `pedido-${order.id}`,
        type: "pedido" as const,
        title: `Pedido #${order.id}`,
        detail: getOrderCustomerLabel(order),
        keywords: [
          String(order.id),
          order.cliente_nombre,
          order.cliente_email,
          order.cliente_username,
          ...orderItems.map(getOrderItemName),
        ]
          .filter(Boolean)
          .join(" "),
        section: "pedidos" as const,
      }
    }),
    ...searchClients.map((client) => ({
      id: `cliente-${client.id}`,
      type: "cliente" as const,
      title:
        client.nombre ||
        client.username ||
        client.email ||
        "Cliente sin nombre",
      detail: client.email || client.telefono || "Cuenta de cliente",
      keywords: [
        client.nombre,
        client.email,
        client.username,
        client.telefono,
        client.dni,
      ]
        .filter(Boolean)
        .join(" "),
      section: "clientes" as const,
    })),
    ...products.slice(0, 80).map((product) => ({
      id: `producto-${product.id}`,
      type: "producto" as const,
      title: product.nombre,
      detail: product.categorias?.nombre ?? "Producto",
      keywords: [
        product.nombre,
        product.slug,
        ...(product.producto_variantes ?? []).map((variant) => variant.nombre),
      ]
        .filter(Boolean)
        .join(" "),
      section: "productos" as const,
    })),
  ]

  return Response.json({
    role: auth.profile.rol,
    stats: {
      totalProductos: getCount(productsCountResult),
      productosActivos: getCount(activeProductsCountResult),
      productosInactivos: getCount(inactiveProductsCountResult),
      productosBajoStock: lowStock.length,
      totalClientes: getCount(clientsCountResult),
      totalOrdenes: getCount(totalOrdersCountResult),
      pedidosPendientes: getCount(pendingOrdersCountResult),
      esperandoComprobante: getCount(waitingProofCountResult),
      pagosEnRevision: getCount(paymentReviewCountResult),
      enviosPendientes: getCount(pendingDispatchCountResult),
      pedidosSinTracking: pendingDispatchOrders.filter(
        (order) =>
          !order.tracking_number &&
          !order.tracking_url &&
          !order.andreani_tracking &&
          !order.andreani_etiqueta_url,
      ).length,
      facturasPendientes: getCount(pendingInvoiceCountResult),
      pedidosPagados: getCount(paidOrdersCountResult),
      pedidosCancelados: getCount(cancelledOrdersCountResult),
      reintegrosPendientes: getCount(pendingRefundCountResult),
      facturasConError: getCount(invoiceErrorCountResult),
      notasCreditoPendientes: getCount(creditNotePendingCountResult),
      stockNegativo: negativeStockItems,
    },
    financialSummary,
    lowStock: sortedLowStock.slice(0, 10),
    recentOrders: recentOrders.map((order) => ({
      ...order,
      total: sensitive ? order.total : 0,
      shipping_cost_real: sensitive ? order.shipping_cost_real : null,
      shipping_cost_charged: sensitive ? order.shipping_cost_charged : null,
      transfer_discount_amount: sensitive
        ? order.transfer_discount_amount
        : null,
    })),
    commercialSales,
    recentActivity,
    systemStatus,
    searchIndex,
  })
}
