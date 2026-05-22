"use client"

import Link from "next/link"

import {
  Pencil,
  Trash2,
  Package,
  ImageIcon,
} from "lucide-react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface ProductosRowProps {
  producto: SupabaseProducto

  isLast?: boolean

  onEdit: (
    producto: SupabaseProducto
  ) => void

  onDelete: (
    id: number
  ) => void

  onToggleActivo: (
    producto: SupabaseProducto
  ) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function ProductosRow({
  producto,
  isLast,
  onEdit,
  onDelete,
  onToggleActivo,
}: ProductosRowProps) {
  return (
    <div
      className={`grid grid-cols-[2fr_1fr_1fr_110px_120px] gap-4 px-5 py-4 items-center transition-colors hover:bg-white/2 ${
        !isLast
          ? "border-b border-white/5"
          : ""
      }`}
    >
      {/* Producto */}
      <div className="flex items-center gap-3 min-w-0">
        {/* Imagen */}
        <div className="size-10 rounded-xl border border-white/6 bg-white flex items-center justify-center shrink-0 overflow-hidden">
          {producto.imagen_principal ? (
            <img
              src={producto.imagen_principal}
              alt={producto.nombre}
              className="w-full h-full object-cover"
            />
          ) : (
            <ImageIcon className="size-4 text-black/20" />
          )}
        </div>

        {/* Info */}
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">
            {producto.nombre}
          </p>

          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {/* Destacado */}
            {producto.destacado && (
              <span className="text-[10px] text-amber-400 font-semibold">
                ★ Destacado
              </span>
            )}

            {/* Stock */}
            <span
              className={`text-[10px] font-semibold ${
                producto.stock <= 0
                  ? "text-red-400"
                  : producto.stock < 5
                  ? "text-amber-400"
                  : "text-green-400"
              }`}
            >
              Stock: {producto.stock}
            </span>
          </div>
        </div>
      </div>

      {/* Categoría */}
      <span className="text-sm text-white/50 truncate">
        {producto.categorias?.nombre ?? "—"}
      </span>

      {/* Precio */}
      <div>
        <span className="text-sm font-semibold text-white tabular-nums">
          ${producto.precio.toLocaleString("es-AR")}
        </span>

        {producto.precio_anterior && (
          <p className="text-[11px] text-white/30 line-through tabular-nums">
            $
            {producto.precio_anterior.toLocaleString(
              "es-AR"
            )}
          </p>
        )}

        {producto.descuento && (
          <p className="text-[10px] text-green-400 font-semibold mt-0.5">
            -{producto.descuento}% OFF
          </p>
        )}
      </div>

      {/* Estado */}
      <button
        type="button"
        onClick={() =>
          onToggleActivo(producto)
        }
        className="cursor-pointer"
      >
        {producto.activo ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 border border-green-500/20 px-2.5 py-1 text-[11px] font-semibold text-green-400">
            <span className="size-1.5 rounded-full bg-green-400" />
            Activo
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-white/35">
            <span className="size-1.5 rounded-full bg-white/25" />
            Inactivo
          </span>
        )}
      </button>

      {/* Acciones */}
      <div className="flex items-center justify-end gap-1.5">
        {/* Preview */}
        <Link
          href={`/producto/${producto.slug}`}
          title="Ver producto"
          className="size-8 rounded-xl border border-white/8 flex items-center justify-center text-white/50 hover:text-[#4A90B8] hover:border-[#4A90B8]/30 transition-colors cursor-pointer"
        >
          <Package className="size-3.5" />
        </Link>

        {/* Editar */}
        <button
          type="button"
          title="Editar"
          onClick={() =>
            onEdit(producto)
          }
          className="size-8 rounded-xl border border-white/8 flex items-center justify-center text-white/50 hover:text-white hover:border-white/20 transition-colors cursor-pointer"
        >
          <Pencil className="size-3.5" />
        </button>

        {/* Eliminar */}
        <button
          type="button"
          title="Eliminar"
          onClick={() =>
            onDelete(producto.id)
          }
          className="size-8 rounded-xl border border-white/8 flex items-center justify-center text-white/50 hover:text-red-400 hover:border-red-500/30 transition-colors cursor-pointer"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}