import { requireInternalUser } from "@/lib/auth/admin-api"
import { canViewSensitiveNumbers } from "@/lib/auth/roles"
import { getAndreaniConfig, isAndreaniReady } from "@/lib/andreani/client"
import { getWsfeHealth } from "@/lib/arca/wsfe"
import { SITE_SETTINGS } from "@/config/site-settings"
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
  const paidOrderFilter =
    "estado.in.(pagado,enviado,en_camino,visita_fallida,en_sucursal,retiro_pendiente,retiro_vencido,en_devolucion,devuelto_beyonix,entregado,approved),payment_status.eq.approved"

  const [
    productsCountResult,
    activeProductsCountResult,
    inactiveProductsCountResult,
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
        .select("id, nombre, stock, activo")
        .eq("activo", true)
        .lte("stock", SITE_SETTINGS.stock.lowStockThreshold)
        .order("stock", { ascending: true })
        .limit(10),
      EMPTY_ROWS_RESULT
    ),
    safeDashboardQuery(
      "variantes_bajo_stock",
      auth.admin
        .from("producto_variantes")
        .select("id, nombre, stock, activo, color_hex, productos(nombre)")
        .eq("activo", true)
        .lte("stock", SITE_SETTINGS.stock.lowStockThreshold)
        .order("stock", { ascending: true })
        .limit(10),
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

  const recentOrders = (recentOrdersResult.data ?? []) as SupabasePedido[]
  const pendingDispatchOrders = (pendingDispatchResult.data ?? []) as SupabasePedido[]
  const pendingInvoiceOrders = (pendingInvoiceResult.data ?? []) as SupabasePedido[]
  const products = (searchProductsResult.data ?? []) as unknown as SupabaseProducto[]
  const mlRows = (mercadoLibreResult.data ?? []) as Array<Record<string, unknown>>

  const paidCandidateOrders = [
    ...recentOrders.filter(isPaidOrder),
    ...pendingDispatchOrders,
    ...pendingInvoiceOrders,
  ]
  const orderIdsForItems = [...new Set(paidCandidateOrders.map((order) => order.id))]
  const itemsResult = orderIdsForItems.length
    ? await safeDashboardQuery(
        "orden_items_recientes",
        auth.admin
          .from("orden_items")
          .select(ORDER_ITEM_SELECT)
          .in("orden_id", orderIdsForItems)
          .limit(300),
        EMPTY_ROWS_RESULT
      )
    : EMPTY_ROWS_RESULT
  const items = (itemsResult.data ?? []) as unknown as SupabasePedidoItem[]
  const itemsByOrderId = groupItemsByOrder(items)
  const lowStockProducts = ((lowStockProductsResult.data ?? []) as Array<{
        id: number
        nombre: string
        stock: number | null
      }>).map((product) => ({
        id: `producto-${product.id}`,
        nombre: product.nombre,
        stock: product.stock ?? 0,
        threshold: SITE_SETTINGS.stock.lowStockThreshold,
        tipo: "producto" as const,
      }))
  const lowStockVariants = ((lowStockVariantsResult.data ?? []) as Array<{
        id: number
        nombre: string
        stock: number | null
        color_hex?: string | null
        productos?: { nombre?: string | null } | null
      }>).map((variant) => ({
        id: `variante-${variant.id}`,
        nombre: variant.nombre,
        producto_nombre: variant.productos?.nombre ?? "Producto",
        stock: variant.stock ?? 0,
        threshold: SITE_SETTINGS.stock.lowStockThreshold,
        tipo: "variante" as const,
        color_hex: variant.color_hex ?? undefined,
      }))
  const lowStock = [...lowStockProducts, ...lowStockVariants]
  const sortedLowStock = [...lowStock].sort((a, b) => a.stock - b.stock)
  const commercialSales: CommercialSale[] = sensitive
    ? [
        ...items
          .map((item) => {
            const order = paidCandidateOrders.find((row) => row.id === item.orden_id)
            const product = item.productos as
              | (SupabaseProducto & { categorias?: { nombre?: string | null } })
              | null
              | undefined
            const quantity = Number(item.cantidad ?? 0)
            const grossAmount = quantity * Number(item.precio ?? 0)

            return {
              id: `web-${item.id}`,
              date: order?.created_at ?? new Date().toISOString(),
              channel: "BEYONIX Web" as const,
              paymentMethod: getPaymentMethodLabel(order),
              productName: product?.nombre ?? `Producto #${item.producto_id}`,
              categoryName: product?.categorias?.nombre ?? null,
              sku: null,
              quantity,
              grossAmount,
              costAmount: null,
              profitAmount: null,
              marginPercent: null,
              orderId: order ? String(order.id) : null,
            }
          }),
        ...mlRows.map((row) => {
          const quantity = Number(row.quantity ?? 0)
          const grossAmount = Number(row.gross_amount ?? 0)
          const netAmount = Number(row.net_amount ?? grossAmount)
          const feeAmount = Number(row.fee_amount ?? 0)
          const shippingAmount = Number(row.shipping_amount ?? 0)
          const profitAmount =
            netAmount || feeAmount || shippingAmount
              ? netAmount || grossAmount - feeAmount - shippingAmount
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
  const searchIndex = [
    ...recentOrders.map((order) => {
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
      totalClientes: null,
      totalOrdenes: getCount(totalOrdersCountResult),
      pedidosPendientes: getCount(pendingOrdersCountResult),
      esperandoComprobante: getCount(waitingProofCountResult),
      pagosEnRevision: getCount(paymentReviewCountResult),
      enviosPendientes: pendingDispatchOrders.length,
      pedidosSinTracking: pendingDispatchOrders.filter(
        (order) =>
          !order.tracking_number &&
          !order.tracking_url &&
          !order.andreani_tracking &&
          !order.andreani_etiqueta_url,
      ).length,
      facturasPendientes: pendingInvoiceOrders.length,
      pedidosPagados: getCount(paidOrdersCountResult),
      pedidosCancelados: getCount(cancelledOrdersCountResult),
    },
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
