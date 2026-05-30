"use client"

import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Clock,
  CreditCard,
  Package,
  RefreshCw,
  ShoppingCart,
  TrendingUp,
  Users,
} from "lucide-react"

import type { AdminSection } from "../../admin-client"
import { useDashboard } from "@/hooks/use-dashboard"
import { formatPrice } from "../productos/helpers"

interface AdminDashboardProps {
  onNavigate: (section: AdminSection) => void
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function SectionHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string
  title: string
  action?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex items-center justify-between gap-4">
      <div>
        {eyebrow && (
          <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            {eyebrow}
          </p>
        )}
        <h2 className="text-xl font-black text-white">{title}</h2>
      </div>
      {action}
    </div>
  )
}

function MetricCard({
  title,
  value,
  helper,
  icon,
  tone = "default",
  onClick,
}: {
  title: string
  value: string | number
  helper?: string
  icon: React.ReactNode
  tone?: "default" | "blue" | "green" | "amber" | "red"
  onClick?: () => void
}) {
  const toneClass = {
    default: "border-white/8 bg-black/85",
    blue: "border-white/8 bg-black/85",
    green: "border-white/8 bg-black/85",
    amber: "border-white/8 bg-black/85",
    red: "border-white/8 bg-black/85",
  }[tone]

  const content = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-11px font-bold uppercase tracking-widest text-white/45">
            {title}
          </p>
          <p className="mt-3 truncate text-3xl font-black text-white">
            {value}
          </p>
          {helper && <p className="mt-2 text-xs text-white/50">{helper}</p>}
        </div>
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-white/8 bg-black/25 text-beyonix-sky">
          {icon}
        </span>
      </div>
      {onClick && (
        <span className="mt-5 inline-flex items-center gap-2 text-xs font-bold text-beyonix-sky">
          Abrir sección <ArrowRight className="size-3.5" />
        </span>
      )}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        title={`Abrir ${title}`}
        aria-label={`Abrir ${title}`}
        onClick={onClick}
        className={`min-h-140px cursor-pointer rounded-3xl border p-5 text-left transition hover:-translate-y-0.5 hover:border-beyonix-sky/50 ${toneClass}`}
      >
        {content}
      </button>
    )
  }

  return (
    <div className={`min-h-140px rounded-3xl border p-5 ${toneClass}`}>
      {content}
    </div>
  )
}

function Skeleton() {
  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="h-28 animate-pulse rounded-3xl border border-white/7 bg-white/3" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="h-140px animate-pulse rounded-3xl border border-white/7 bg-white/3"
          />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="h-320px animate-pulse rounded-3xl border border-white/7 bg-white/3" />
        <div className="h-320px animate-pulse rounded-3xl border border-white/7 bg-white/3" />
      </div>
    </div>
  )
}

export function AdminDashboard({ onNavigate }: AdminDashboardProps) {
  const {
    stats,
    lowStock,
    recentOrders,
    recentClients,
    topSellingProducts,
    loading,
    error,
    reloadDashboard,
  } = useDashboard()

  if (loading || !stats) return <Skeleton />

  const alerts = [
    stats.productosBajoStock > 0
      ? `${stats.productosBajoStock} productos o variantes con stock bajo.`
      : null,
    stats.pedidosPendientes > 0
      ? `${stats.pedidosPendientes} pedidos pendientes requieren seguimiento.`
      : null,
    stats.clientesActivos === 0
      ? "Usuarios activos en tiempo real no está disponible sin tabla de sesiones."
      : null,
  ].filter(Boolean)

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="rounded-3xl border border-white/8 bg-beyonix-blue p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="mb-2 text-11px font-bold uppercase tracking-widest text-beyonix-sky">
              Centro de control
            </p>
            <h1 className="text-3xl font-black text-white lg:text-4xl">
              Dashboard BEYONIX
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/68">
              Ventas, clientes, stock, pedidos y alertas operativas en un solo
              panel.
            </p>
          </div>
          <button
            type="button"
            title="Actualizar dashboard"
            aria-label="Actualizar dashboard"
            onClick={() => void reloadDashboard()}
            className="inline-flex h-12 min-w-140px items-center justify-center gap-2 rounded-2xl border border-white/12 bg-white px-6 text-sm font-black text-black transition hover:bg-white/90"
          >
            <RefreshCw className="size-4" />
            Actualizar
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Productos"
          value={stats.totalProductos}
          helper={`${stats.productosActivos} activos`}
          icon={<Package className="size-5" />}
          tone="blue"
          onClick={() => onNavigate("productos")}
        />
        <MetricCard
          title="Stock bajo"
          value={stats.productosBajoStock}
          helper="Incluye variantes"
          icon={<AlertTriangle className="size-5" />}
          tone={stats.productosBajoStock ? "amber" : "green"}
          onClick={() => onNavigate("productos")}
        />
        <MetricCard
          title="Clientes"
          value={stats.totalClientes}
          helper="Registrados"
          icon={<Users className="size-5" />}
          onClick={() => onNavigate("clientes")}
        />
        <MetricCard
          title="Activos"
          value={stats.clientesActivos}
          helper="Requiere sesiones en base"
          icon={<BadgeCheck className="size-5" />}
          onClick={() => onNavigate("activos")}
        />
        <MetricCard
          title="Pedidos"
          value={stats.totalOrdenes}
          helper={`${stats.pedidosPendientes} pendientes`}
          icon={<ShoppingCart className="size-5" />}
          onClick={() => onNavigate("pedidos")}
        />
        <MetricCard
          title="Pagados"
          value={stats.pedidosPagados}
          helper={`${stats.pedidosCancelados} cancelados`}
          icon={<CreditCard className="size-5" />}
          tone="green"
          onClick={() => onNavigate("pedidos")}
        />
        <MetricCard
          title="Facturación total"
          value={formatPrice(stats.facturacionTotal)}
          helper="Pedidos aprobados"
          icon={<TrendingUp className="size-5" />}
          tone="blue"
        />
        <MetricCard
          title="Facturación mes"
          value={formatPrice(stats.facturacionMes)}
          helper={`Hoy ${formatPrice(stats.facturacionDia)}`}
          icon={<Clock className="size-5" />}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          title="Facturación día"
          value={formatPrice(stats.facturacionDia)}
          icon={<TrendingUp className="size-5" />}
        />
        <MetricCard
          title="Facturación semana"
          value={formatPrice(stats.facturacionSemana)}
          icon={<TrendingUp className="size-5" />}
        />
        <MetricCard
          title="Pendientes"
          value={stats.pedidosPendientes}
          icon={<ShoppingCart className="size-5" />}
          tone={stats.pedidosPendientes ? "amber" : "green"}
          onClick={() => onNavigate("pedidos")}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-3xl border border-white/8 bg-beyonix-surface p-5">
          <SectionHeader eyebrow="Operación" title="Últimas órdenes" />
          <div className="space-y-3">
            {recentOrders.length ? (
              recentOrders.map((order) => (
                <button
                  type="button"
                  title={`Abrir pedido ${order.id}`}
                  aria-label={`Abrir pedido ${order.id}`}
                  key={order.id}
                  onClick={() => onNavigate("pedidos")}
                  className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-2xl border border-white/7 bg-black px-4 py-3 text-left transition hover:border-beyonix-blue-light"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-white">
                      Pedido #{order.id}
                    </span>
                    <span className="mt-1 block truncate text-xs text-white/45">
                      {order.cliente_nombre || order.cliente_email || "Cliente"}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm font-black text-white">
                      {formatPrice(order.total)}
                    </span>
                    <span className="mt-1 block text-11px uppercase text-white/42">
                      {formatDate(order.created_at)}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <p className="rounded-2xl border border-white/7 bg-black px-4 py-5 text-sm text-white/55">
                No hay órdenes todavía.
              </p>
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-white/8 bg-beyonix-surface p-5">
          <SectionHeader eyebrow="Clientes" title="Últimos registrados" />
          <div className="space-y-3">
            {recentClients.length ? (
              recentClients.map((client) => (
                <button
                  type="button"
                  title={`Abrir cliente ${client.nombre}`}
                  aria-label={`Abrir cliente ${client.nombre}`}
                  key={client.id}
                  onClick={() => onNavigate("clientes")}
                  className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-2xl border border-white/7 bg-black px-4 py-3 text-left transition hover:border-beyonix-blue-light"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-white">
                      {client.username || client.nombre}
                    </span>
                    <span className="mt-1 block truncate text-xs text-white/45">
                      {client.email}
                    </span>
                  </span>
                  <span className="text-11px uppercase text-white/42">
                    {formatDate(client.created_at)}
                  </span>
                </button>
              ))
            ) : (
              <p className="rounded-2xl border border-white/7 bg-black px-4 py-5 text-sm text-white/55">
                No hay clientes registrados todavía.
              </p>
            )}
          </div>
        </section>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <section className="rounded-3xl border border-white/8 bg-beyonix-surface p-5 xl:col-span-2">
          <SectionHeader eyebrow="Ranking" title="Productos más vendidos" />
          <div className="space-y-3">
            {topSellingProducts.length ? (
              topSellingProducts.map((product) => (
                <div
                  key={product.id}
                  className="grid gap-3 rounded-2xl border border-white/7 bg-black px-4 py-3 sm:grid-cols-3 sm:items-center"
                >
                  <p className="truncate text-sm font-bold text-white">
                    {product.nombre}
                  </p>
                  <p className="text-sm text-white/55">
                    {product.cantidad} unidades
                  </p>
                  <p className="text-sm font-black text-white sm:text-right">
                    {formatPrice(product.total)}
                  </p>
                </div>
              ))
            ) : (
              <p className="rounded-2xl border border-white/7 bg-black px-4 py-5 text-sm text-white/55">
                Todavía no hay ventas para construir el ranking.
              </p>
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-white/8 bg-beyonix-surface p-5">
          <SectionHeader eyebrow="Alertas" title="Importantes" />
          <div className="space-y-3">
            {alerts.length ? (
              alerts.map((alert) => (
                <div
                  key={alert}
                  className="rounded-2xl border border-amber-400/20 bg-amber-400/8 px-4 py-3 text-sm text-amber-100"
                >
                  {alert}
                </div>
              ))
            ) : (
              <p className="rounded-2xl border border-emerald-400/20 bg-emerald-400/8 px-4 py-5 text-sm text-emerald-100">
                No hay alertas críticas en este momento.
              </p>
            )}
          </div>
        </section>
      </div>

      <section className="rounded-3xl border border-white/8 bg-beyonix-surface p-5">
        <SectionHeader eyebrow="Stock" title="Productos sin stock o bajo stock" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {lowStock.length ? (
            lowStock.map((item) => (
              <button
                type="button"
                title="Abrir productos"
                aria-label="Abrir productos"
                key={item.id}
                onClick={() => onNavigate("productos")}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-white/7 bg-black px-4 py-3 text-left transition hover:border-amber-400/35"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-white">
                    {item.producto_nombre || item.nombre}
                  </span>
                  <span className="mt-1 block truncate text-xs text-white/45">
                    {item.tipo === "variante" ? item.nombre : "Producto"}
                  </span>
                </span>
                <span
                  className={`rounded-full border px-3 py-1 text-xs font-black ${
                    item.stock <= 0
                      ? "border-red-400/25 bg-red-400/10 text-red-300"
                      : "border-amber-400/25 bg-amber-400/10 text-amber-200"
                  }`}
                >
                  {item.stock}
                </span>
              </button>
            ))
          ) : (
            <p className="rounded-2xl border border-white/7 bg-black px-4 py-5 text-sm text-white/55 md:col-span-2 xl:col-span-3">
              No hay productos con stock bajo.
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
