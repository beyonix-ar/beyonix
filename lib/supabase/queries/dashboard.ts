import { supabase } from "@/lib/supabase/client"

import type {
  SupabasePedido,
  SupabasePedidoItem,
  SupabaseProducto,
  SupabaseProfile,
} from "@/lib/supabase/types"
import { SITE_SETTINGS } from "@/config/site-settings"

export interface LowStockItem {
  id: string
  nombre: string
  stock: number
  tipo: "producto" | "variante"
  producto_nombre?: string
  color_hex?: string
}

export interface TopSellingProduct {
  id: number
  nombre: string
  cantidad: number
  total: number
}

interface PresenceRow {
  user_id: string
  last_seen_at: string | null
}

export interface DashboardStats {
  totalProductos: number
  productosActivos: number
  productosBajoStock: number
  totalClientes: number
  clientesActivos: number
  totalOrdenes: number
  pedidosPendientes: number
  pedidosPagados: number
  pedidosCancelados: number
  facturacionTotal: number
  facturacionDia: number
  facturacionSemana: number
  facturacionMes: number
}

const PAID_STATES = new Set(["pagado", "enviado", "entregado", "approved"])

function getStartOfDay() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date
}

function getStartOfWeek() {
  const date = getStartOfDay()
  const day = date.getDay()
  const diff = day === 0 ? 6 : day - 1
  date.setDate(date.getDate() - diff)
  return date
}

function getStartOfMonth() {
  const date = getStartOfDay()
  date.setDate(1)
  return date
}

function isPaidOrder(order: SupabasePedido) {
  return PAID_STATES.has(order.estado) || order.payment_status === "approved"
}

function getOrderRevenue(order: SupabasePedido) {
  return isPaidOrder(order) ? Number(order.total ?? 0) : 0
}

function getStock(producto: SupabaseProducto) {
  const variantes = producto.producto_variantes ?? []
  if (!variantes.length) return producto.stock ?? 0

  return variantes.reduce((total, variante) => total + (variante.stock ?? 0), 0)
}

function getLowStock(productos: SupabaseProducto[]) {
  return productos
    .filter((producto) => producto.activo)
    .reduce<LowStockItem[]>((items, producto) => {
      const variantes = producto.producto_variantes ?? []

      if (variantes.length) {
        return [
          ...items,
          ...variantes
            .filter(
              (variante) =>
                variante.activo &&
                (variante.stock ?? 0) <=
                  SITE_SETTINGS.stock.lowStockThreshold
            )
            .map((variante) => ({
              id: `variante-${variante.id}`,
              nombre: variante.nombre,
              stock: variante.stock ?? 0,
              tipo: "variante" as const,
              producto_nombre: producto.nombre,
              color_hex: variante.color_hex,
            })),
        ]
      }

      if ((producto.stock ?? 0) <= SITE_SETTINGS.stock.lowStockThreshold) {
        return [
          ...items,
          {
            id: `producto-${producto.id}`,
            nombre: producto.nombre,
            stock: producto.stock ?? 0,
            tipo: "producto",
          },
        ]
      }

      return items
    }, [])
    .sort((a, b) => a.stock - b.stock)
}

function getTopSellingProducts(items: SupabasePedidoItem[]) {
  const byProduct = items.reduce<Record<number, TopSellingProduct>>((acc, item) => {
    const productId = item.producto_id
    const productName = item.productos?.nombre ?? `Producto #${productId}`
    const quantity = Number(item.cantidad ?? 0)
    const total = quantity * Number(item.precio ?? 0)

    acc[productId] = {
      id: productId,
      nombre: productName,
      cantidad: (acc[productId]?.cantidad ?? 0) + quantity,
      total: (acc[productId]?.total ?? 0) + total,
    }

    return acc
  }, {})

  return Object.values(byProduct)
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, 6)
}

function throwDashboardQueryError(label: string, error: unknown): never {
  console.error("DASHBOARD_QUERY_ERROR", {
    query: label,
    message:
      error && typeof error === "object" && "message" in error
        ? error.message
        : undefined,
    details:
      error && typeof error === "object" && "details" in error
        ? error.details
        : undefined,
    hint:
      error && typeof error === "object" && "hint" in error
        ? error.hint
        : undefined,
    code:
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined,
    error,
  })

  throw error
}

export async function getDashboardData() {
  const [productosResult, clientesResult, ordenesResult, itemsResult, presenceResult] =
    await Promise.all([
      supabase
        .from("productos")
        .select("*, categorias(*), imagenes_producto(*), producto_variantes(*)"),
      supabase
        .from("profiles")
        .select(
          "id, created_at, nombre, username, telefono, codigo_postal, provincia, avatar_url, referencias, client_risk_status, admin_note, blocked_at, blocked_reason, blocked_by, calle, numero, piso, departamento, localidad, rol"
        )
        .eq("rol", "cliente")
        .order("created_at", { ascending: false }),
      supabase
        .from("ordenes")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("orden_items")
        .select("*, productos(*), producto_variantes(*)"),
      supabase.rpc("admin_get_client_presence"),
    ])

  if (productosResult.error) {
    throwDashboardQueryError("productos", productosResult.error)
  }

  if (clientesResult.error) {
    console.error("DASHBOARD_QUERY_ERROR", {
      query: "admin_get_client_profiles",
      message: clientesResult.error?.message,
      details: clientesResult.error?.details,
      hint: clientesResult.error?.hint,
      code: clientesResult.error?.code,
    })
    throwDashboardQueryError("profiles", clientesResult.error)
  }
  if (ordenesResult.error) {
    throwDashboardQueryError("ordenes", ordenesResult.error)
  }
  if (itemsResult.error) {
    throwDashboardQueryError("orden_items", itemsResult.error)
  }

  const productos = (productosResult.data ?? []) as SupabaseProducto[]
  const clientes = ((clientesResult.data ?? []) as SupabaseProfile[]).filter(
    (profile) => profile.rol === "cliente"
  )
  const ordenes = (ordenesResult.data ?? []) as SupabasePedido[]
  const items = (itemsResult.data ?? []) as SupabasePedidoItem[]
  const activeSince = Date.now() - 5 * 60 * 1000
  const presenceRows = presenceResult.error
    ? []
    : ((presenceResult.data ?? []) as PresenceRow[])
  const clientIds = new Set(clientes.map((cliente) => cliente.id))
  const activeClients = presenceRows
    .filter((row) => clientIds.has(row.user_id))
    .filter((row) =>
      row.last_seen_at
        ? new Date(row.last_seen_at).getTime() >= activeSince
        : false
    ).length

  const itemsByOrder = items.reduce<Record<number, SupabasePedidoItem[]>>(
    (acc, item) => {
      acc[item.orden_id] = [...(acc[item.orden_id] ?? []), item]
      return acc
    },
    {}
  )

  const ordersWithItems = ordenes.map((order) => ({
    ...order,
    orden_items: itemsByOrder[order.id] ?? [],
  }))

  const lowStock = getLowStock(productos)
  const dayStart = getStartOfDay()
  const weekStart = getStartOfWeek()
  const monthStart = getStartOfMonth()

  const stats: DashboardStats = {
    totalProductos: productos.length,
    productosActivos: productos.filter((producto) => producto.activo).length,
    productosBajoStock: lowStock.length,
    totalClientes: clientes.length,
    clientesActivos: activeClients,
    totalOrdenes: ordenes.length,
    pedidosPendientes: ordenes.filter((order) => order.estado === "pendiente").length,
    pedidosPagados: ordenes.filter((order) => isPaidOrder(order)).length,
    pedidosCancelados: ordenes.filter((order) => order.estado === "cancelado").length,
    facturacionTotal: ordenes.reduce((total, order) => total + getOrderRevenue(order), 0),
    facturacionDia: ordenes
      .filter((order) => new Date(order.created_at) >= dayStart)
      .reduce((total, order) => total + getOrderRevenue(order), 0),
    facturacionSemana: ordenes
      .filter((order) => new Date(order.created_at) >= weekStart)
      .reduce((total, order) => total + getOrderRevenue(order), 0),
    facturacionMes: ordenes
      .filter((order) => new Date(order.created_at) >= monthStart)
      .reduce((total, order) => total + getOrderRevenue(order), 0),
  }

  return {
    stats,
    lowStock: lowStock.slice(0, 10),
    recentOrders: ordersWithItems.slice(0, 8),
    recentClients: clientes.slice(0, 8),
    topSellingProducts: getTopSellingProducts(items),
  }
}
