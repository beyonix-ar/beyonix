import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseProducto,
  SupabasePedido,
  SupabaseProfile,
} from "@/lib/supabase/types"

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

export async function getLowStockProducts() {
  const { data, error } =
    await supabase
      .from("productos")
      .select("*")
      .lte("stock", 5)
      .eq("activo", true)
      .order("stock", {
        ascending: true,
      })
      .limit(10)

  if (error) {
    throw error
  }

  return (data ??
    []) as SupabaseProducto[]
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