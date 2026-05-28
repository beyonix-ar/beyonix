import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseProducto,
  SupabasePedido,
  SupabaseProfile,
} from "@/lib/supabase/types"

export interface LowStockItem {
  id: string
  nombre: string
  stock: number
  tipo: "producto" | "variante"
  producto_nombre?: string
  color_hex?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard stats
// ─────────────────────────────────────────────────────────────────────────────

export interface DashboardStats {
  totalProductos: number

  totalClientes: number

  totalordenes: number

  productosActivos: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Get dashboard stats
// ─────────────────────────────────────────────────────────────────────────────

export async function getDashboardStats(): Promise<DashboardStats> {
  // Productos
  const {
    count: totalProductos,
    error: productosError,
  } = await supabase
    .from("productos")
    .select("*", {
      count: "exact",
      head: true,
    })

  if (productosError) {
    throw productosError
  }

  // Productos activos
  const {
    count: productosActivos,
    error: activosError,
  } = await supabase
    .from("productos")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("activo", true)

  if (activosError) {
    throw activosError
  }

  // Clientes
  const {
    count: totalClientes,
    error: clientesError,
  } = await supabase
    .from("profiles")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("rol", "cliente")

  if (clientesError) {
    throw clientesError
  }

  // ordenes
  const {
    count: totalordenes,
    error: ordenesError,
  } = await supabase
    .from("ordenes")
    .select("*", {
      count: "exact",
      head: true,
    })

  if (ordenesError) {
    throw ordenesError
  }

  return {
    totalProductos:
      totalProductos ?? 0,

    totalClientes:
      totalClientes ?? 0,

    totalordenes:
      totalordenes ?? 0,

    productosActivos:
      productosActivos ?? 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get low stock products
// ─────────────────────────────────────────────────────────────────────────────

export async function getLowStockProducts(): Promise<
  LowStockItem[]
> {
  const { data, error } =
    await supabase
      .from("productos")
      .select(
        "*, producto_variantes(*)"
      )
      .eq("activo", true)

  if (error) {
    throw error
  }

  const productos =
    (data ?? []) as SupabaseProducto[]

  const lowStockItems =
    productos.reduce<LowStockItem[]>(
      (items, producto) => {
      const variantes =
        producto.producto_variantes || []

      if (variantes.length) {
        const variantItems =
          variantes
          .filter(
            (variante) =>
              variante.activo &&
              (variante.stock ?? 0) <= 5
          )
          .map((variante) => ({
            id: `variante-${variante.id}`,
            nombre: variante.nombre,
            stock: variante.stock ?? 0,
            tipo: "variante" as const,
            producto_nombre:
              producto.nombre,
            color_hex:
              variante.color_hex,
          } satisfies LowStockItem))

        return [
          ...items,
          ...variantItems,
        ]
      }

      if (producto.stock <= 5) {
        return [
          ...items,
          {
            id: `producto-${producto.id}`,
            nombre: producto.nombre,
            stock: producto.stock,
            tipo: "producto" as const,
          } satisfies LowStockItem,
        ]
      }

      return items
    },
    []
  )

  return lowStockItems
    .sort((a, b) => a.stock - b.stock)
    .slice(0, 10)
}

// ─────────────────────────────────────────────────────────────────────────────
// Get recent orders
// ─────────────────────────────────────────────────────────────────────────────

export async function getRecentOrders() {
  const { data, error } =
    await supabase
      .from("ordenes")
      .select("*")
      .order("created_at", {
        ascending: false,
      })
      .limit(10)

  if (error) {
    throw error
  }

  return (data ??
    []) as SupabasePedido[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Get recent clients
// ─────────────────────────────────────────────────────────────────────────────

export async function getRecentClients() {
  const { data, error } =
    await supabase
      .from("profiles")
      .select("*")
      .eq("rol", "cliente")
      .order("created_at", {
        ascending: false,
      })
      .limit(10)

  if (error) {
    throw error
  }

  return (data ??
    []) as SupabaseProfile[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Get total revenue
// ─────────────────────────────────────────────────────────────────────────────

export async function getTotalRevenue() {
  const { data, error } =
    await supabase
      .from("ordenes")
      .select("total")

  if (error) {
    throw error
  }

  const total =
    (data ?? []).reduce(
      (acc, pedido) =>
        acc + Number(pedido.total),
      0
    )

  return total
}
