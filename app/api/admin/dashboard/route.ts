import { requireInternalUser } from "@/lib/auth/admin-api"
import { canViewSensitiveNumbers } from "@/lib/auth/roles"
import { getSiteSettings } from "@/lib/site-settings"
import { calculateOperatingResult } from "@/lib/business/commercial-sale-financials"
import {
  buildDashboardLedger,
  type AuthorizedCreditNoteRow,
  type CommercialSale,
  type CreditMovementRow,
  type ExpenseRow,
  type MercadoLibreReturnReviewRow,
  type ProductCostRow,
} from "@/lib/business/dashboard-commercial-ledger"
import { isDashboardPaidSale } from "@/lib/business/dashboard-financials"
import type { DashboardFinancialSummary } from "@/lib/supabase/queries/dashboard"
import type {
  SupabasePedido,
  SupabasePedidoItem,
  SupabaseProducto,
} from "@/lib/supabase/types"
import { isAdminOrderVisible } from "@/lib/orders/admin-order-visibility"

const PAYMENT_REVIEW_STATES = new Set(["pendiente_comprobante", "en_revision"])
const DASHBOARD_SERVER_CACHE_MS = 60_000
const dashboardServerCache = new Map<
  string,
  { expiresAt: number; payload: Record<string, unknown> }
>()

interface RecentActivity {
  id: string
  type: "venta" | "pedido" | "pago" | "despacho"
  title: string
  detail: string
  meta?: string
  secondary?: string
  created_at: string
}

// Venta cobrada = hubo pago confirmado (aunque después se cancele): la
// reversión se descuenta aparte (getOrderRevenueReversal).
function isPaidOrder(order: SupabasePedido) {
  return isDashboardPaidSale(order)
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

// cliente_username NO es una columna de ordenes -- nunca lo fue (ver
// lib/supabase/types.ts y app/api/admin/pedidos/route.ts): el username vive
// en profiles y se resuelve por usuario_id, igual que en ese endpoint. Se
// incluye usuario_id acá para poder hacer ese mismo lookup donde haga falta.
const ORDER_SELECT = `
  id,
  estado,
  total,
  usuario_id,
  cliente_nombre,
  cliente_email,
  payment_id,
  payment_status,
  payment_method_id,
  payment_type_id,
  payment_proof_url,
  payment_proof_file_name,
  payment_proof_uploaded_at,
  paid_at,
  payment_confirmed_amount,
  financial_status,
  admin_visible_at,
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
  sku,
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
  return_restocked_quantity,
  return_written_off_quantity,
  costo_unitario_historico,
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
  mercadopago_payment_snapshot,
  shipping_provider,
  envio_proveedor,
  shipping_cost_real,
  shipping_cost_charged,
  shipping_provider_quote_amount,
  andreani_costo,
  transfer_discount_amount,
  invoice_status,
  invoice_created_at,
  credit_note_required,
  credit_note_status,
  credit_note_amount,
  created_at
`

export async function GET(request: Request) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth.error

  const sensitive = canViewSensitiveNumbers(auth.profile.rol)
  const cacheKey = auth.profile.rol
  const forceRefresh =
    new URL(request.url).searchParams.get("refresh") === "1"
  const cached = dashboardServerCache.get(cacheKey)
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return Response.json(cached.payload, {
      headers: { "X-Dashboard-Cache": "HIT" },
    })
  }
  const { stock: stockSettings } = await getSiteSettings()
  const paidOrderFilter =
    "estado.in.(pagado,enviado,en_camino,visita_fallida,en_sucursal,retiro_pendiente,retiro_vencido,en_devolucion,devuelto_beyonix,entregado,approved),payment_status.eq.approved"

  const primaryDataPromise = Promise.all([
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
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .not("admin_visible_at", "is", null),
      EMPTY_COUNT_RESULT
    ),
    safeDashboardQuery(
      "ordenes_recientes",
      auth.admin
        .from("ordenes")
        .select(ORDER_SELECT)
        .not("admin_visible_at", "is", null)
        .order("admin_visible_at", { ascending: false })
        .limit(8),
      EMPTY_ROWS_RESULT
    ),
    safeDashboardQuery(
      "ordenes_pendientes_count",
      auth.admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .not("admin_visible_at", "is", null)
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
        .not("admin_visible_at", "is", null)
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
        .not("admin_visible_at", "is", null)
        .order("admin_visible_at", { ascending: false })
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
  ])

  const financialDataPromise = Promise.all([
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
              .select("id, sale_date, imported_at, order_id, product_id, product_name, sku, quantity, gross_amount, fee_amount, shipping_amount, net_amount, raw_data, costo_unitario_historico")
              .order("id", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({
          rows: [] as Array<Record<string, unknown>>,
          complete: true,
        }),
    sensitive
      ? fetchAllDashboardRows<Record<string, unknown>>(
          "ventas_externas",
          (from, to) =>
            auth.admin
              .from("external_sales")
              .select("id, sale_date, product_id, variant_id, product_name, sku, quantity, unit_cost, costo_unitario_historico, gross_amount, fee_amount, shipping_amount, other_expense_amount, net_amount, payment_method, reference, status, reversal_kind, return_condition, stock_effect, declared_profit")
              .order("id", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({
          rows: [] as Array<Record<string, unknown>>,
          complete: true,
        }),
    safeDashboardQuery(
      "productos_stock_negativo",
      auth.admin
        .from("productos")
        .select("id")
        .lt("stock", 0),
      EMPTY_ROWS_RESULT,
    ),
    safeDashboardQuery(
      "variantes_stock_negativo",
      auth.admin
        .from("producto_variantes")
        .select("id, producto_id")
        .lt("stock", 0),
      EMPTY_ROWS_RESULT,
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
              .select(
                "id, product_id, variant_id, article_name, sku, purchase_date, quantity, received_quantity, reception_status, total_cost, created_at",
              )
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
              .select(
                "expense_date, amount, status, expense_type, product_id, variant_id, quantity",
              )
              .order("expense_date", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({ rows: [] as ExpenseRow[], complete: true }),
    sensitive
      ? fetchAllDashboardRows<MercadoLibreReturnReviewRow>(
          "revisiones_devolucion_ml",
          (from, to) =>
            auth.admin
              .from("inventory_return_movements")
              .select(
                "mercadolibre_sale_id, sellable_quantity, discounted_quantity, non_sellable_quantity",
              )
              .not("mercadolibre_sale_id", "is", null)
              .order("mercadolibre_sale_id", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({
          rows: [] as MercadoLibreReturnReviewRow[],
          complete: true,
        }),
    sensitive
      ? fetchAllDashboardRows<AuthorizedCreditNoteRow>(
          "notas_credito_autorizadas",
          (from, to) =>
            auth.admin
              .from("order_credit_notes")
              .select(
                "id, order_id, total_amount, manual_amount, customer_credit_amount, original_shipping_refunded, authorized_at, order_credit_note_items(order_item_id, quantity, total_amount)",
              )
              .eq("status", "authorized")
              .order("created_at", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({
          rows: [] as AuthorizedCreditNoteRow[],
          complete: true,
        }),
    // Saldo a favor por pedido desde los movimientos reales: 'debit' = saldo
    // aplicado al comprar, 'reversal' = saldo restituido. ordenes no guarda
    // estos datos de forma estable (credit_balance_used se descuenta al
    // restituir).
    sensitive
      ? fetchAllDashboardRows<CreditMovementRow>(
          "saldo_por_pedido",
          (from, to) =>
            auth.admin
              .from("customer_credit_movements")
              .select("order_id, amount, movement_type")
              .in("movement_type", ["debit", "reversal"])
              .not("order_id", "is", null)
              .order("created_at", { ascending: true })
              .range(from, to),
        )
      : Promise.resolve({ rows: [] as CreditMovementRow[], complete: true }),
  ])

  const [
    [
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
    ],
    [
      financialOrdersScan,
      orderItemsScan,
      marketplaceScan,
      externalSalesScan,
      negativeProductsResult,
      negativeVariantsResult,
      pendingDispatchCountResult,
      pendingInvoiceCountResult,
      pendingRefundCountResult,
      invoiceErrorCountResult,
      creditNotePendingCountResult,
      productCostsScan,
      expensesScan,
      mlReturnReviewScan,
      authorizedCreditNotesScan,
      creditRestorationsScan,
    ],
  ] = await Promise.all([primaryDataPromise, financialDataPromise])

  const recentOrders = (
    (recentOrdersResult.data ?? []) as SupabasePedido[]
  ).filter(isAdminOrderVisible)
  const pendingDispatchOrders = (pendingDispatchResult.data ?? []) as SupabasePedido[]
  const pendingInvoiceOrders = (pendingInvoiceResult.data ?? []) as SupabasePedido[]
  const products = (searchProductsResult.data ?? []) as unknown as SupabaseProducto[]
  const mlRows = sensitive
    ? marketplaceScan.rows
    : (mercadoLibreResult.data ?? []) as Array<Record<string, unknown>>
  const financialOrders = financialOrdersScan.rows
  const paidCandidateOrders = sensitive
    ? financialOrders.filter(isPaidOrder)
    : [
        ...recentOrders.filter(isPaidOrder),
        ...pendingDispatchOrders,
        ...pendingInvoiceOrders,
      ]
  const paidOrderIds = new Set(paidCandidateOrders.map((order) => order.id))
  const items = orderItemsScan.rows.filter((item) => paidOrderIds.has(item.orden_id))
  const itemsByOrderId = groupItemsByOrder(items)
  // Fuente única de las cifras financieras: cada venta (web, ML, externa) se
  // normaliza a la misma semántica (ver lib/business/dashboard-commercial-ledger.ts).
  // El resumen histórico suma estas líneas y el panel comercial las filtra por
  // período: ningún KPI recalcula con una fórmula propia.
  const ledger = buildDashboardLedger({
    orders: sensitive ? paidCandidateOrders : [],
    items: sensitive ? items : [],
    authorizedCreditNotes: authorizedCreditNotesScan.rows.filter((note) =>
      paidOrderIds.has(note.order_id),
    ),
    creditMovements: creditRestorationsScan.rows,
    marketplaceRows: sensitive ? marketplaceScan.rows : [],
    marketplaceReturnReviews: mlReturnReviewScan.rows,
    externalRows: externalSalesScan.rows,
    productCosts: productCostsScan.rows,
    expenses: expensesScan.rows,
  })
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
  const negativeVariants = (negativeVariantsResult.data ?? []) as Array<{
    id: number
    producto_id: number
  }>
  const negativeProducts = (negativeProductsResult.data ?? []) as Array<{
    id: number
  }>
  const negativeVariantProductIds = new Set(
    negativeVariants.map((variant) => Number(variant.producto_id)),
  )
  // Si una variante ya explica el saldo negativo del producto, se informa una
  // sola vez. El padre sólo se suma cuando la anomalía no está localizada.
  const unexplainedNegativeProducts = negativeProducts
    .filter((product) => !negativeVariantProductIds.has(Number(product.id)))
    .length
  const negativeStockItems =
    negativeVariants.length + unexplainedNegativeProducts
  const { totals, channels } = ledger
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
    authorizedCreditNotesScan.complete &&
    creditRestorationsScan.complete &&
    marketplaceScan.complete &&
    mlReturnReviewScan.complete &&
    externalSalesScan.complete &&
    productCostsScan.complete &&
    expensesScan.complete
  // Sin lectura completa o con mercadería sin costo (también la regalada como
  // gasto) no se informa resultado: nunca se completa un costo con 0.
  const contributionResult = scanComplete ? totals.contributionResult : null
  const productExpenseCostMissing =
    ledger.expenses.coveredUnits < ledger.expenses.costableUnits
  const operatingResult = productExpenseCostMissing
    ? null
    : calculateOperatingResult(contributionResult, ledger.expenses.paid)
  const formatArs = (value: number) =>
    value.toLocaleString("es-AR", { style: "currency", currency: "ARS" })
  const financialWarnings = [
    ...(!scanComplete
      ? ["La lectura histórica o las tablas de costos están incompletas. Aplicá la migración pendiente y revisá el servidor."]
      : []),
    ...(ledger.costCoveragePercent < 99.999
      ? [`Los costos cubren el ${ledger.costCoveragePercent.toFixed(1)}% de las unidades vendidas o entregadas como gasto. Completá las compras faltantes para obtener el resultado.`]
      : []),
    ...(productExpenseCostMissing
      ? ["Hay mercadería entregada como gasto (donación o sorteo) sin costo determinable: el resultado estimado queda pendiente."]
      : []),
    ...(totals.inferredCostUnits > 0
      ? [`${totals.inferredCostPercent.toFixed(1)}% de las unidades tiene costo inferido desde la ganancia declarada (ventas externas históricas), no un costo de compra.`]
      : []),
    ...(ledger.external.inconsistentProfitSales > 0
      ? [`${ledger.external.inconsistentProfitSales} ventas externas declaran una ganancia mayor que su ingreso neto: su costo no es determinable y quedan fuera de la cobertura de costos. Revisalas en Ventas externas.`]
      : []),
    ...(ledger.web.ambiguousReversalOrders > 0
      ? [`${ledger.web.ambiguousReversalOrders} pedidos tienen una nota de crédito sin ítem ni envío asociado y una devolución física sin nota de crédito: no se puede saber si son la misma reversión, así que su facturación y su resultado quedan pendientes. Vinculá la nota al producto devuelto.`]
      : []),
    ...(ledger.web.ordersWithoutItems > 0
      ? [`${ledger.web.ordersWithoutItems} pedidos pagos no tienen detalle de artículos y no pueden costearse.`]
      : []),
    ...(expensesScan.rows.length === 0
      ? ["No hay gastos generales registrados: el resultado estimado sólo considera ventas y costos."]
      : []),
    ...(ledger.expenses.pending > 0
      ? [`Hay ${formatArs(ledger.expenses.pending)} en gastos pendientes de pago (no se restan del resultado).`]
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
    ...(ledger.web.pendingReturnAdjustment > 0
      ? [`${formatArs(ledger.web.pendingReturnAdjustment)} en ventas ya recibidas físicamente en devolución están descontados de las ventas netas a la espera de su nota de crédito.`]
      : []),
  ]
  const financialSummary: DashboardFinancialSummary = {
    webGrossSales: channels.web.grossSales,
    marketplaceGrossSales: channels.marketplace.grossSales,
    externalGrossSales: channels.external.grossSales,
    grossSales: totals.grossSales,
    completedRefunds:
      ledger.web.completedRefunds +
      ledger.marketplace.refunds +
      ledger.external.damagedReturnReversals,
    pendingRefunds: ledger.web.pendingRefunds,
    pendingReturnAdjustment: ledger.web.pendingReturnAdjustment,
    billedSales: totals.grossAmount,
    netSales: totals.netSales,
    webNetSales: channels.web.netSales,
    marketplaceNet: channels.marketplace.netSales,
    externalNet: channels.external.netSales,
    externalCollected: ledger.web.externalCollected,
    customerCreditUsed: ledger.web.customerCreditUsed,
    shippingCharged: ledger.web.shippingCharged,
    shippingCost: totals.shippingCost,
    shippingBalance: ledger.web.shippingCharged - ledger.web.shippingCost,
    transferDiscounts: ledger.web.transferDiscounts,
    webMercadoPagoFees: ledger.web.mercadoPagoFees,
    marketplaceFees: ledger.marketplace.fees,
    marketplaceRefunds: ledger.marketplace.refunds,
    marketplaceShipping: ledger.marketplace.shipping,
    salesFees: totals.fees,
    otherDirectCosts: totals.otherCosts,
    inventoryPurchases: ledger.inventoryPurchases,
    costOfGoodsSold: totals.costOfGoodsSold,
    contributionResult,
    operatingExpensesPaid: ledger.expenses.paid,
    productExpenseEconomicCost: ledger.expenses.productEconomicCost,
    operatingExpensesPending: ledger.expenses.pending,
    operatingResult,
    operatingMarginPercent:
      operatingResult != null && totals.grossAmount != null && totals.grossAmount > 0
        ? (operatingResult / totals.grossAmount) * 100
        : null,
    costCoveragePercent: ledger.costCoveragePercent,
    inferredCostPercent: totals.inferredCostPercent,
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
    externalRowsScanned: externalSalesScan.rows.filter((row) => row.status !== "reversed").length,
    complete: scanComplete,
    generatedAt: new Date().toISOString(),
    warnings: financialWarnings,
  }
  const commercialSales: CommercialSale[] = sensitive ? ledger.sales : []
  const paidExpensesByDate = sensitive ? ledger.expenses.paidByDate : []
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
      created_at: order.admin_visible_at || order.paid_at || order.created_at,
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
      created_at: order.admin_visible_at || order.paid_at || order.created_at,
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
      created_at: order.admin_visible_at || order.paid_at || order.created_at,
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
        created_at: order.admin_visible_at || order.created_at,
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
  const searchOrders = (searchOrdersResult.data ?? []) as unknown as SupabasePedido[]
  // El username del cliente no vive en ordenes -- se resuelve por usuario_id
  // contra profiles, igual que en app/api/admin/pedidos/route.ts. Fallback a
  // un Map vacío si el lookup falla: no vale la pena tirar todo el dashboard
  // por no poder indexar el username en la búsqueda de pedidos.
  const searchOrderUserIds = Array.from(
    new Set(
      searchOrders
        .map((order) => order.usuario_id)
        .filter((id): id is string => Boolean(id)),
    ),
  )
  const usernameByUserId = new Map<string, string | null>()
  if (searchOrderUserIds.length) {
    const { data: searchOrderProfiles, error: searchOrderProfilesError } =
      await auth.admin
        .from("profiles")
        .select("id, username")
        .in("id", searchOrderUserIds)

    if (searchOrderProfilesError) {
      console.warn("DASHBOARD_QUERY_FALLBACK:ordenes_busqueda_usernames", {
        query: "ordenes_busqueda_usernames",
        ...getErrorLogDetails(searchOrderProfilesError),
      })
    } else {
      for (const profile of (searchOrderProfiles ?? []) as Array<{
        id: string
        username: string | null
      }>) {
        usernameByUserId.set(profile.id, profile.username)
      }
    }
  }
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
          order.usuario_id ? usernameByUserId.get(order.usuario_id) : null,
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
        product.sku,
        ...(product.producto_variantes ?? []).map((variant) => variant.nombre),
      ]
        .filter(Boolean)
        .join(" "),
      section: "productos" as const,
    })),
  ]

  const payload = {
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
    paidExpensesByDate,
    recentActivity,
    searchIndex,
  }
  dashboardServerCache.set(cacheKey, {
    payload,
    expiresAt: Date.now() + DASHBOARD_SERVER_CACHE_MS,
  })

  return Response.json(payload, {
    headers: { "X-Dashboard-Cache": "MISS" },
  })
}
