"use client"

import { useMemo, useState } from "react"

import {
  ShoppingCart,
  Trash2,
} from "lucide-react"

import { usePedidos } from "@/hooks/use-pedidos"

import { formatPrice } from "../productos/helpers"

function formatOrderDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

// ─────────────────────────────────────────────────────────────────────────────
// Badge
// ─────────────────────────────────────────────────────────────────────────────

function EstadoBadge({
  estado,
}: {
  estado: string
}) {
  const styles: Record<
    string,
    string
  > = {
    pendiente:
      "bg-amber-500/10 border-amber-500/20 text-amber-400",

    pagado:
      "bg-green-500/10 border-green-500/20 text-green-400",

    enviado:
      "bg-blue-500/10 border-blue-500/20 text-blue-400",

    cancelado:
      "bg-red-500/10 border-red-500/20 text-red-400",
  }

  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-full border text-11px font-semibold capitalize ${
        styles[estado] ??
        "bg-white/5 border-white/10 text-white/50"
      }`}
    >
      {estado}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function AdminPedidos() {
  const {
    pedidos,
    loading,
    deletePedido,
    updatePedidoEstado,
  } = usePedidos()

  const [search, setSearch] =
    useState("")

  const pedidosFiltrados =
    useMemo(
      () =>
        pedidos.filter((p) =>
          [
            String(p.id),
            p.cliente_nombre ?? "",
            p.cliente_email ?? "",
            p.cliente_telefono ?? "",
          ]
            .join(" ")
            .toLowerCase()
            .includes(search.toLowerCase())
        ),
      [pedidos, search]
    )

  const handleDelete = async (
    id: number
  ) => {
    const ok = confirm(
      "¿Eliminar pedido?"
    )

    if (!ok) return

    await deletePedido(id)
  }

  const handleEstadoChange = async (
    pedidoId: number,
    estadoActual: string,
    nextEstado: string
  ) => {
    if (estadoActual === nextEstado) return

    if (
      nextEstado === "pagado" &&
      estadoActual !== "pagado"
    ) {
      alert("El estado pagado se actualiza automáticamente desde Mercado Pago.")
      return
    }

    if (nextEstado === "enviado") {
      const trackingNumber =
        prompt("Número de seguimiento (opcional)")?.trim() || null
      const trackingUrl =
        prompt("Link de seguimiento (opcional)")?.trim() || null

      await updatePedidoEstado(pedidoId, nextEstado, {
        tracking_number: trackingNumber,
        tracking_url: trackingUrl,
      })
      return
    }

    await updatePedidoEstado(pedidoId, nextEstado)
  }

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan mb-1">
            Pedidos
          </p>

          <h1 className="text-3xl font-bold text-white">
            Gestión de pedidos
          </h1>
        </div>

        <input
          type="text"
          title="Buscar pedido"
          placeholder="Buscar pedido..."
          value={search}
          onChange={(e) =>
            setSearch(
              e.target.value
            )
          }
          className="w-72 h-12 bg-beyonix-surface border border-white/8 rounded-2xl px-4 text-sm text-white placeholder:text-white/25 outline-none focus:border-beyonix-blue-light transition-colors"
        />
      </div>

      {/* Loading */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-2xl border border-white/6 bg-white/2 animate-pulse"
            />
          ))}
        </div>
      ) : pedidosFiltrados.length ===
        0 ? (
        <div className="rounded-3xl border border-white/7 bg-beyonix-surface p-12 text-center">
          <ShoppingCart className="size-10 text-white/15 mx-auto mb-3" />

          <p className="text-sm font-medium text-white/60">
            No hay pedidos todavía.
          </p>
        </div>
      ) : (
        <div className="rounded-3xl border border-white/7 overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-admin-orders gap-4 px-5 py-3 border-b border-white/6 bg-beyonix-surface">
            <span className="text-10px uppercase tracking-widest text-white/45 font-semibold">
              Pedido
            </span>

            <span className="text-10px uppercase tracking-widest text-white/45 font-semibold">
              Cliente
            </span>

            <span className="text-10px uppercase tracking-widest text-white/45 font-semibold">
              Fecha
            </span>

            <span className="text-10px uppercase tracking-widest text-white/45 font-semibold">
              Estado
            </span>

            <span className="text-10px uppercase tracking-widest text-white/45 font-semibold">
              Total
            </span>

            <span className="text-10px uppercase tracking-widest text-white/45 font-semibold text-right">
              Acciones
            </span>
          </div>

          {/* Rows */}
          {pedidosFiltrados.map(
            (pedido, i) => (
              <div
                key={pedido.id}
                className={`grid grid-cols-admin-orders gap-4 px-5 py-4 items-center hover:bg-white/2 transition-colors ${
                  i <
                  pedidosFiltrados.length -
                    1
                    ? "border-b border-white/5"
                    : ""
                }`}
              >
                {/* ID */}
                <div>
                  <p className="text-sm font-semibold text-white">
                    #{pedido.id}
                  </p>
                </div>

                {/* Cliente */}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">
                    {pedido.cliente_nombre ||
                      "Cliente sin nombre"}
                  </p>

                  <p className="truncate text-11px text-white/45">
                    {pedido.cliente_email ||
                      pedido.cliente_telefono ||
                      pedido.usuario_id}
                  </p>
                </div>

                {/* Fecha */}
                <div>
                  <p className="text-sm text-white/75">
                    {formatOrderDate(
                      pedido.created_at
                    )}
                  </p>
                </div>

                {/* Estado */}
                <div>
                  <select
                    title="Estado del pedido"
                    aria-label="Estado del pedido"
                    value={pedido.estado}
                    onChange={(e) =>
                      handleEstadoChange(
                        pedido.id,
                        pedido.estado,
                        e.target.value
                      )
                    }
                    className="h-10 bg-beyonix-page border border-white/8 rounded-xl px-3 text-sm text-white outline-none"
                  >
                    <option value="pendiente">
                      Pendiente
                    </option>

                    <option value="pagado">
                      Pagado
                    </option>

                    <option value="enviado">
                      Enviado
                    </option>

                    <option value="cancelado">
                      Cancelado
                    </option>
                  </select>
                </div>

                {/* Total */}
                <div>
                  <p className="text-sm font-semibold text-white">
                    {formatPrice(
                      pedido.total
                    )}
                  </p>
                  {pedido.tracking_url && (
                    <a
                      href={pedido.tracking_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block text-11px text-beyonix-cyan underline underline-offset-4"
                    >
                      Ver seguimiento
                    </a>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-2">
                  <EstadoBadge
                    estado={
                      pedido.estado
                    }
                  />

                  <button
                    type="button"
                    aria-label={`Eliminar pedido ${pedido.id}`}
                    title="Eliminar pedido"
                    onClick={() =>
                      handleDelete(
                        pedido.id
                      )
                    }
                    className="size-8 rounded-xl border border-white/8 flex items-center justify-center text-white/60 hover:text-red-400 hover:border-red-500/30 transition-colors cursor-pointer"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
