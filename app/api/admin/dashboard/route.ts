import { requireInternalUser } from "@/lib/auth/admin-api"
import { canViewSensitiveNumbers } from "@/lib/auth/roles"
import { SITE_SETTINGS } from "@/config/site-settings"
import type {
  SupabasePedido,
  SupabasePedidoItem,
  SupabaseProducto,
} from "@/lib/supabase/types"

const PAID_STATES = new Set(["pagado", "enviado", "entregado", "approved"])
const PAYMENT_REVIEW_STATES = new Set(["pendiente_comprobante", "en_revision"])

interface DashboardLowStockItem {
  id: string
  nombre: string
  stock: number
  tipo: "producto" | "variante"
  producto_nombre?: string
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
  type: "venta" | "pedido" | "pago" | "stock"
  title: string
  detail: string
  meta?: string
  secondary?: string
  created_at: string
}

function isPaidOrder(order: SupabasePedido) {
  return PAID_STATES.has(order.estado) || order.payment_status === "approved"
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

function getOrderItemLabel(item: SupabasePedidoItem) {
  const productName = item.productos?.nombre ?? `Producto #${item.producto_id}`
  const variantName = item.producto_variantes?.nombre
  const quantity = Number(item.cantidad ?? 1) || 1

  return `${productName}${variantName ? ` ${variantName}` : ""} x${quantity}`
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth.error

  const [
    productsResult,
    ordersResult,
    itemsResult,
    mercadoLibreResult,
  ] =
    await Promise.all([
      auth.admin
        .from("productos")
        .select("*, producto_variantes(*)")
        .order("id", { ascending: false }),
      auth.admin.from("ordenes").select("*").order("created_at", {
        ascending: false,
      }),
      auth.admin
        .from("orden_items")
        .select("*, productos(id, nombre, categorias(nombre)), producto_variantes(nombre)"),
      auth.admin
        .from("mercadolibre_sales")
        .select("*")
        .order("sale_date", { ascending: false })
        .limit(1000),
    ])

  const error =
    productsResult.error ||
    ordersResult.error ||
    itemsResult.error

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const products = (productsResult.data ?? []) as SupabaseProducto[]
  const orders = (ordersResult.data ?? []) as SupabasePedido[]
  const items = (itemsResult.data ?? []) as SupabasePedidoItem[]
  const mlRows = mercadoLibreResult.error
    ? []
    : ((mercadoLibreResult.data ?? []) as Array<Record<string, unknown>>)
  const lowStock = products.flatMap<DashboardLowStockItem>((product) => {
    const variants = product.producto_variantes ?? []
    if (variants.length) {
      return variants
        .filter(
          (variant) =>
            variant.activo &&
            (variant.stock ?? 0) <= SITE_SETTINGS.stock.lowStockThreshold
        )
        .map((variant) => ({
          id: `variante-${variant.id}`,
          nombre: variant.nombre,
          producto_nombre: product.nombre,
          stock: variant.stock ?? 0,
          tipo: "variante" as const,
        }))
    }

    return product.activo &&
      (product.stock ?? 0) <= SITE_SETTINGS.stock.lowStockThreshold
      ? [{
          id: `producto-${product.id}`,
          nombre: product.nombre,
          stock: product.stock ?? 0,
          tipo: "producto" as const,
        }]
      : []
  })
  const paidOrders = orders.filter(isPaidOrder)
  const sensitive = canViewSensitiveNumbers(auth.profile.rol)
  const paymentReviewOrders = orders.filter((order) =>
    PAYMENT_REVIEW_STATES.has(order.payment_status ?? "")
  )
  const pendingDispatchOrders = orders.filter(
    (order) =>
      isPaidOrder(order) &&
      !["enviado", "entregado", "cancelado"].includes(order.estado)
  )
  const commercialSales: CommercialSale[] = sensitive
    ? [
        ...items
          .filter((item) =>
            paidOrders.some((order) => order.id === item.orden_id)
          )
          .map((item) => {
            const order = paidOrders.find((row) => row.id === item.orden_id)
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
            date: String(row.sale_date ?? row.imported_at ?? new Date().toISOString()),
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
  const ordersById = new Map(orders.map((order) => [order.id, order]))
  const recentWebSales = items
    .map<RecentActivity | null>((item) => {
      const order = ordersById.get(item.orden_id)
      if (!order || !isPaidOrder(order)) return null

      return {
        id: `venta-web-${item.id}`,
        type: "venta",
        title: "Nueva venta realizada",
        detail: getOrderItemLabel(item),
        meta: getPaymentMethodLabel(order),
        secondary: `Orden #${order.id}`,
        created_at: order.paid_at || order.created_at,
      }
    })
    .filter(Boolean) as RecentActivity[]
  const recentMercadoLibreSales: RecentActivity[] = mlRows
    .slice(0, 10)
    .map((row) => ({
      id: `venta-ml-${String(row.id)}`,
      type: "venta",
      title: "Nueva venta realizada",
      detail: `${String(row.product_name ?? "Venta MercadoLibre")} x${Number(row.quantity ?? 1) || 1}`,
      meta: "MercadoLibre",
      secondary: row.order_id ? `Orden #${String(row.order_id)}` : "Marketplace",
      created_at: String(row.sale_date ?? row.imported_at ?? new Date().toISOString()),
    }))
  const paymentConfirmedActivity: RecentActivity[] = paidOrders
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
    ...orders.filter((order) => !isPaidOrder(order)).slice(0, 5).map((order) => ({
      id: `pedido-${order.id}`,
      type: "pedido" as const,
      title: "Pedido pendiente",
      detail: `Orden #${order.id}`,
      meta: `${getOrderCustomerLabel(order)} · ${order.estado}`,
      created_at: order.created_at,
    })),
    ...paymentReviewOrders.slice(0, 5).map((order) => ({
      id: `pago-${order.id}`,
      type: "pago" as const,
      title: "Pago en revisión",
      detail: `Orden #${order.id}`,
      meta: order.payment_proof_file_name
        ? "Comprobante recibido"
        : "Transferencia pendiente",
      created_at: order.payment_proof_uploaded_at || order.created_at,
    })),
    ...lowStock.slice(0, 8).map((item) => ({
      id: `stock-${item.id}`,
      type: "stock" as const,
      title: "Stock bajo",
      detail: item.producto_nombre || item.nombre,
      meta: `Quedan ${item.stock} unidades`,
      secondary: item.tipo === "variante" ? item.nombre : undefined,
      created_at: new Date().toISOString(),
    })),
  ]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    .slice(0, 10)

  return Response.json({
    role: auth.profile.rol,
    stats: {
      totalProductos: products.length,
      productosActivos: products.filter((product) => product.activo).length,
      productosInactivos: products.filter((product) => !product.activo).length,
      productosBajoStock: lowStock.length,
      totalClientes: null,
      totalOrdenes: orders.length,
      pedidosPendientes: orders.filter((order) => order.estado === "pendiente")
        .length,
      esperandoComprobante: orders.filter(
        (order) =>
          order.payment_method_id === "transferencia" &&
          !order.payment_proof_url &&
          !["confirmado", "approved", "rechazado"].includes(
            order.payment_status ?? ""
          )
      ).length,
      pagosEnRevision: paymentReviewOrders.length,
      enviosPendientes: pendingDispatchOrders.length,
      pedidosSinTracking: pendingDispatchOrders.filter(
        (order) =>
          !order.tracking_number &&
          !order.tracking_url &&
          !order.andreani_tracking &&
          !order.andreani_etiqueta_url
      ).length,
      pedidosPagados: paidOrders.length,
      pedidosCancelados: orders.filter((order) => order.estado === "cancelado")
        .length,
    },
    lowStock: lowStock.sort((a, b) => a.stock - b.stock).slice(0, 10),
    recentOrders: orders.slice(0, 8).map((order) => ({
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
  })
}
