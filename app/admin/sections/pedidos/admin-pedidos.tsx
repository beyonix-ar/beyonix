"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, Search, ShoppingCart, Trash2 } from "lucide-react"

import { usePedidos } from "@/hooks/use-pedidos"
import type { SupabasePedido } from "@/lib/supabase/types"
import { AdminSelect, AdminTextInput } from "../../components/admin-controls"
import { formatPrice } from "../productos/helpers"

type StatusFilter = "todos" | "pendiente" | "pagado" | "enviado" | "cancelado"

function formatOrderDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

function getDispatchAlert(pedido: SupabasePedido) {
  const dispatched =
    pedido.estado === "enviado" ||
    pedido.estado === "entregado" ||
    Boolean(pedido.tracking_number || pedido.tracking_url)

  if (dispatched || pedido.estado === "cancelado") {
    return {
      label: "Despachado",
      className: "border-beyonix-blue-light/35 bg-beyonix-blue text-beyonix-sky",
    }
  }

  const hours = (Date.now() - new Date(pedido.created_at).getTime()) / 36e5

  if (hours > 24) {
    return {
      label: "Urgente",
      className: "border-red-400/25 bg-red-400/10 text-red-300",
    }
  }

  if (hours > 12) {
    return {
      label: "Atención",
      className: "border-amber-400/25 bg-amber-400/10 text-amber-200",
    }
  }

  return {
    label: "A tiempo",
    className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  }
}

function EstadoBadge({ estado }: { estado: string }) {
  const styles: Record<string, string> = {
    pendiente: "border-amber-500/20 bg-amber-500/10 text-amber-300",
    pagado: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    enviado: "border-beyonix-blue-light/35 bg-beyonix-blue text-beyonix-sky",
    cancelado: "border-red-500/20 bg-red-500/10 text-red-300",
  }

  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${
        styles[estado] ?? "border-white/10 bg-white/5 text-white/60"
      }`}
    >
      {estado}
    </span>
  )
}

function ProductsSummary({ pedido }: { pedido: SupabasePedido }) {
  const items = pedido.orden_items ?? []

  if (!items.length) {
    return (
      <span title="Sin detalle cargado" className="text-xs text-white/55">
        Sin detalle cargado
      </span>
    )
  }

  return (
    <div className="space-y-1">
      {items.slice(0, 3).map((item) => {
        const text = `${item.productos?.nombre ?? `Producto #${item.producto_id}`}${
          item.producto_variantes?.nombre ? ` · ${item.producto_variantes.nombre}` : ""
        } x${item.cantidad}`

        return (
          <p key={item.id} title={text} className="truncate text-xs text-white/68">
            {text}
          </p>
        )
      })}
      {items.length > 3 && (
        <p className="text-11px text-white/48">+{items.length - 3} productos</p>
      )}
    </div>
  )
}

export function AdminPedidos() {
  const { pedidos, loading, error, deletePedido, updatePedidoEstado } =
    usePedidos()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todos")

  const pedidosFiltrados = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()

    return pedidos.filter((pedido) => {
      const matchesSearch = [
        String(pedido.id),
        pedido.cliente_nombre ?? "",
        pedido.cliente_email ?? "",
        pedido.cliente_telefono ?? "",
        pedido.cliente_direccion ?? "",
        pedido.payment_method_id ?? "",
        pedido.orden_items?.map((item) => item.productos?.nombre ?? "").join(" ") ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch)
      const matchesStatus =
        statusFilter === "todos" || pedido.estado === statusFilter

      return matchesSearch && matchesStatus
    })
  }, [pedidos, search, statusFilter])

  const handleDelete = async (id: number) => {
    const ok = confirm("¿Eliminar pedido?")
    if (!ok) return
    await deletePedido(id)
  }

  const handleEstadoChange = async (
    pedidoId: number,
    estadoActual: string,
    nextEstado: string
  ) => {
    if (estadoActual === nextEstado) return

    if (nextEstado === "pagado" && estadoActual !== "pagado") {
      alert("El estado pagado se actualiza automáticamente desde Mercado Pago.")
      return
    }

    if (nextEstado === "enviado") {
      const trackingNumber =
        prompt("Número de seguimiento (opcional)")?.trim() || null
      const trackingUrl = prompt("Link de seguimiento (opcional)")?.trim() || null

      await updatePedidoEstado(pedidoId, nextEstado, {
        tracking_number: trackingNumber,
        tracking_url: trackingUrl,
      })
      return
    }

    await updatePedidoEstado(pedidoId, nextEstado)
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            Pedidos
          </p>
          <h1 className="text-3xl font-black text-white/95">Gestión de pedidos</h1>
          <p className="mt-2 text-sm text-white/68">
            Seguimiento de pago, productos, envío y prioridad de despacho.
          </p>
        </div>

        <div className="grid w-full gap-3 sm:grid-cols-admin-order-filters xl:max-w-2xl">
          <AdminTextInput
            title="Buscar pedido"
            ariaLabel="Buscar pedido"
            placeholder="Buscar pedido, cliente o producto"
            value={search}
            icon={<Search className="size-4" />}
            onChange={setSearch}
          />

          <AdminSelect
            title="Filtrar estado"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
          >
            <option value="todos">Todos los estados</option>
            <option value="pendiente">Pendientes</option>
            <option value="pagado">Pagados</option>
            <option value="enviado">Enviados</option>
            <option value="cancelado">Cancelados</option>
          </AdminSelect>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 7 }).map((_, index) => (
            <div
              key={index}
              className="h-112px animate-pulse rounded-3xl border border-white/7 bg-white/3"
            />
          ))}
        </div>
      ) : pedidosFiltrados.length === 0 ? (
        <div className="rounded-3xl border border-white/8 bg-black p-12 text-center">
          <ShoppingCart className="mx-auto mb-4 size-11 text-white/24" />
          <p className="text-sm font-bold text-white/72">
            No hay pedidos para los filtros seleccionados.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="hidden grid-cols-admin-orders-pro gap-4 rounded-2xl border border-white/8 bg-black px-5 py-3 xl:grid">
            {[
              "Pedido",
              "Cliente",
              "Productos",
              "Fecha",
              "Estado",
              "Despacho",
              "Total",
              "Acciones",
            ].map((label) => (
              <span
                key={label}
                title={label}
                className={`text-10px font-bold uppercase tracking-widest text-white/48 ${
                  label === "Acciones" ? "pr-2 text-right" : ""
                }`}
              >
                {label}
              </span>
            ))}
          </div>

          {pedidosFiltrados.map((pedido) => {
            const dispatch = getDispatchAlert(pedido)
            const paymentMethod =
              pedido.payment_method_id || pedido.payment_type_id || "Método no informado"
            const trackingText =
              pedido.tracking_number || "Seguimiento pendiente"

            return (
              <article
                key={pedido.id}
                className="rounded-3xl border border-white/8 bg-black px-5 py-4 transition hover:border-beyonix-blue-light/45"
              >
                <div className="grid gap-4 xl:grid-cols-admin-orders-pro xl:items-center">
                  <div>
                    <p className="text-sm font-black text-white/95">#{pedido.id}</p>
                    <p
                      title={pedido.payment_id ? `Pago ${pedido.payment_id}` : "Sin ID pago"}
                      className="mt-1 truncate text-11px text-white/55"
                    >
                      {pedido.payment_id ? `Pago ${pedido.payment_id}` : "Sin ID pago"}
                    </p>
                  </div>

                  <div className="min-w-0">
                    <p
                      title={pedido.cliente_nombre || "Cliente sin nombre"}
                      className="truncate text-sm font-bold text-white/92"
                    >
                      {pedido.cliente_nombre || "Cliente sin nombre"}
                    </p>
                    <p
                      title={pedido.cliente_email || pedido.cliente_telefono || "-"}
                      className="mt-1 truncate text-xs text-white/58"
                    >
                      {pedido.cliente_email || pedido.cliente_telefono || "-"}
                    </p>
                    {pedido.cliente_direccion && (
                      <p
                        title={pedido.cliente_direccion}
                        className="mt-1 truncate text-11px text-white/48"
                      >
                        {pedido.cliente_direccion}
                      </p>
                    )}
                  </div>

                  <ProductsSummary pedido={pedido} />

                  <p title={formatOrderDate(pedido.created_at)} className="text-sm text-white/76">
                    {formatOrderDate(pedido.created_at)}
                  </p>

                  <div>
                    <AdminSelect
                      title="Estado del pedido"
                      value={pedido.estado}
                      onChange={(value) =>
                        handleEstadoChange(pedido.id, pedido.estado, value)
                      }
                    >
                      <option value="pendiente">Pendiente</option>
                      <option value="pagado">Pagado</option>
                      <option value="enviado">Enviado</option>
                      <option value="cancelado">Cancelado</option>
                    </AdminSelect>
                    <div className="mt-2">
                      <EstadoBadge estado={pedido.estado} />
                    </div>
                  </div>

                  <div>
                    <span
                      title={dispatch.label}
                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-11px font-black uppercase tracking-wide ${dispatch.className}`}
                    >
                      <AlertTriangle className="size-3.5" />
                      {dispatch.label}
                    </span>
                    <p title={trackingText} className="mt-2 truncate text-11px text-white/58">
                      {trackingText}
                    </p>
                    {pedido.tracking_url && (
                      <a
                        href={pedido.tracking_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block text-11px font-bold text-beyonix-sky underline underline-offset-4"
                      >
                        Ver seguimiento
                      </a>
                    )}
                  </div>

                  <div>
                    <p className="text-sm font-black text-white/95">
                      {formatPrice(pedido.total)}
                    </p>
                    <p title={paymentMethod} className="mt-1 truncate text-11px text-white/58">
                      {paymentMethod}
                    </p>
                  </div>

                  <div className="flex justify-end pr-2">
                    <button
                      type="button"
                      aria-label={`Eliminar pedido ${pedido.id}`}
                      title="Eliminar pedido"
                      onClick={() => handleDelete(pedido.id)}
                      className="flex size-9 cursor-pointer items-center justify-center rounded-xl border border-white/8 text-white/62 transition-colors hover:border-red-500/30 hover:text-red-300"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
