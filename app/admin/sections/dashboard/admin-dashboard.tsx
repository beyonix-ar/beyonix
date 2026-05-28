"use client"

import {
  Package,
  ShoppingCart,
  Users,
  BadgeCheck,
  AlertTriangle,
} from "lucide-react"

import { useDashboard } from "@/hooks/use-dashboard"

import { formatPrice } from "../productos/helpers"

// ─────────────────────────────────────────────────────────────────────────────
// Card
// ─────────────────────────────────────────────────────────────────────────────

interface StatCardProps {
  title: string
  value: string | number
  icon: React.ReactNode
}

function StatCard({
  title,
  value,
  icon,
}: StatCardProps) {
  return (
    <div className="rounded-3xl border border-white/7 bg-beyonix-surface p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-white/45 font-semibold mb-2">
            {title}
          </p>

          <h3 className="text-3xl font-bold text-white">
            {value}
          </h3>
        </div>

        <div className="size-11 rounded-2xl bg-white/5 border border-white/6 flex items-center justify-center text-white/80">
          {icon}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function AdminDashboard() {
  const {
    stats,
    lowStock,
    recentOrders,
    revenue,
    loading,
  } = useDashboard()

  // ───────────────────────────────────────────────────────────────────────────
  // Loading
  // ───────────────────────────────────────────────────────────────────────────

  if (loading || !stats) {
    return (
      <div className="p-8 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-36 rounded-3xl border border-white/6 bg-white/2 animate-pulse"
            />
          ))}
        </div>

        <div className="grid grid-cols-2 gap-6">
          {[...Array(2)].map((_, i) => (
            <div
              key={i}
              className="h-96 rounded-3xl border border-white/6 bg-white/2 animate-pulse"
            />
          ))}
        </div>
      </div>
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UI
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div>
        <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan mb-1">
          Dashboard
        </p>

        <h1 className="text-3xl font-bold text-white">
          Resumen general
        </h1>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          title="Productos"
          value={
            stats.totalProductos
          }
          icon={
            <Package className="size-5" />
          }
        />

        <StatCard
          title="Clientes"
          value={
            stats.totalClientes
          }
          icon={
            <Users className="size-5" />
          }
        />

        <StatCard
          title="Órdenes"
          value={
            stats.totalordenes
          }
          icon={
            <ShoppingCart className="size-5" />
          }
        />

        <StatCard
          title="Activos"
          value={
            stats.productosActivos
          }
          icon={
            <BadgeCheck className="size-5" />
          }
        />
      </div>

      {/* Revenue */}
      <div className="rounded-3xl border border-white/7 bg-beyonix-surface p-6">
        <p className="text-xs uppercase tracking-widest text-white/45 font-semibold mb-2">
          Facturación total
        </p>

        <h2 className="text-4xl font-bold text-white">
          {formatPrice(revenue)}
        </h2>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 gap-6">
        {/* Low stock */}
        <div className="rounded-3xl border border-white/7 bg-beyonix-surface p-6">
          <div className="flex items-center gap-2 mb-5">
            <AlertTriangle className="size-4 text-amber-400" />

            <h2 className="text-lg font-semibold text-white">
              Stock bajo
            </h2>
          </div>

          <div className="space-y-3">
            {lowStock.length === 0 ? (
              <p className="text-sm text-white/50">
                No hay productos con stock bajo.
              </p>
            ) : (
              lowStock.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-2xl border border-white/6 bg-white/2 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    {p.color_hex && (
                      <span
                        className="size-4 rounded-full border border-white/20"
                        style={{
                          backgroundColor:
                            p.color_hex,
                        }}
                      />
                    )}

                    <div>
                      <p className="text-sm font-medium text-white">
                        {p.tipo === "variante" &&
                        p.producto_nombre
                          ? p.producto_nombre
                          : p.nombre}
                      </p>

                      <p className="text-xs text-white/45 mt-1">
                        {p.tipo === "variante"
                          ? `Variante: ${p.nombre}`
                          : "Producto sin variantes"}
                      </p>
                    </div>
                  </div>

                  <span
                    className={`text-sm font-semibold ${
                      p.stock <= 0
                        ? "text-red-400"
                        : "text-amber-400"
                    }`}
                  >
                    {p.stock}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent orders */}
        <div className="rounded-3xl border border-white/7 bg-beyonix-surface p-6">
          <div className="flex items-center gap-2 mb-5">
            <ShoppingCart className="size-4 text-beyonix-cyan" />

            <h2 className="text-lg font-semibold text-white">
              Últimas órdenes
            </h2>
          </div>

          <div className="space-y-3">
            {recentOrders.length === 0 ? (
              <p className="text-sm text-white/50">
                No hay órdenes todavía.
              </p>
            ) : (
              recentOrders.map((pedido) => (
                <div
                  key={pedido.id}
                  className="flex items-center justify-between rounded-2xl border border-white/6 bg-white/2 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium text-white">
                      Pedido #{pedido.id}
                    </p>

                    <p className="text-xs text-white/45 mt-1">
                      {pedido.estado}
                    </p>
                  </div>

                  <span className="text-sm font-semibold text-white">
                    {formatPrice(
                      pedido.total
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
