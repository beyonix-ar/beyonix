"use client"

import { useMemo, useState } from "react"

import {
  ShoppingCart,
  Trash2,
} from "lucide-react"

import { usePedidos } from "@/hooks/use-pedidos"

import { formatPrice } from "../productos/helpers"

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
      className={`inline-flex items-center px-2.5 py-1 rounded-full border text-[11px] font-semibold capitalize ${
        styles[estado] ??
        "bg-white/5 border-white/10 text-white/40"
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
          String(p.id).includes(
            search
          )
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

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-1">
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
          className="w-72 h-12 bg-[#0A0A0A] border border-white/8 rounded-2xl px-4 text-sm text-white placeholder:text-white/25 outline-none focus:border-[#1E4D7B] transition-colors"
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
        <div className="rounded-3xl border border-white/7 bg-[#0A0A0A] p-12 text-center">
          <ShoppingCart className="size-10 text-white/15 mx-auto mb-3" />

          <p className="text-sm font-medium text-white/50">
            No hay pedidos todavía.
          </p>
        </div>
      ) : (
        <div className="rounded-3xl border border-white/7 overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[120px_1fr_180px_140px_120px] gap-4 px-5 py-3 border-b border-white/6 bg-[#0A0A0A]">
            <span className="text-[10px] uppercase tracking-[0.2em] text-white/35 font-semibold">
              Pedido
            </span>

            <span className="text-[10px] uppercase tracking-[0.2em] text-white/35 font-semibold">
              Fecha
            </span>

            <span className="text-[10px] uppercase tracking-[0.2em] text-white/35 font-semibold">
              Estado
            </span>

            <span className="text-[10px] uppercase tracking-[0.2em] text-white/35 font-semibold">
              Total
            </span>

            <span className="text-[10px] uppercase tracking-[0.2em] text-white/35 font-semibold text-right">
              Acciones
            </span>
          </div>

          {/* Rows */}
          {pedidosFiltrados.map(
            (pedido, i) => (
              <div
                key={pedido.id}
                className={`grid grid-cols-[120px_1fr_180px_140px_120px] gap-4 px-5 py-4 items-center hover:bg-white/2 transition-colors ${
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

                {/* Fecha */}
                <div>
                  <p className="text-sm text-white/65">
                    {new Date(
                      pedido.created_at
                    ).toLocaleDateString(
                      "es-AR"
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
                      updatePedidoEstado(
                        pedido.id,
                        e.target.value
                      )
                    }
                    className="h-10 bg-[#050505] border border-white/8 rounded-xl px-3 text-sm text-white outline-none"
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
                    title="Eliminar pedido"
                    onClick={() =>
                      handleDelete(
                        pedido.id
                      )
                    }
                    className="size-8 rounded-xl border border-white/8 flex items-center justify-center text-white/50 hover:text-red-400 hover:border-red-500/30 transition-colors cursor-pointer"
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