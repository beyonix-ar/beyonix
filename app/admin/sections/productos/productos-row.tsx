"use client"

import Link from "next/link"

import {
  ImageIcon,
  Package,
  Pencil,
  Trash2,
} from "lucide-react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

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

const stockColor = (
  stock: number
) => {
  if (stock <= 0) {
    return "text-red-400"
  }

  if (stock < 5) {
    return "text-amber-400"
  }

  return "text-green-400"
}

export function ProductosRow({
  producto,
  isLast,
  onEdit,
  onDelete,
  onToggleActivo,
}: ProductosRowProps) {
  return (
    <div
      className={`grid grid-cols-[2fr_1fr_1fr_110px_120px] items-center gap-4 px-5 py-4 transition-colors hover:bg-white/2 ${
        !isLast
          ? "border-b border-white/5"
          : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/6 bg-white">
          {producto.imagen_principal ? (
            <img
              alt={
                producto.nombre
              }
              src={
                producto.imagen_principal
              }
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageIcon className="size-4 text-black/20" />
          )}
        </div>

        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">
            {producto.nombre}
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-2">
            {producto.destacado && (
              <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-10px font-semibold text-amber-400">
                Destacado
              </span>
            )}

            <span
              className={`text-10px font-semibold ${stockColor(
                producto.stock
              )}`}
            >
              Stock:{" "}
              {producto.stock}
            </span>
          </div>
        </div>
      </div>

      <span className="truncate text-sm text-white/50">
        {producto.categorias
          ?.nombre || "—"}
      </span>

      <div>
        <p className="text-sm font-semibold tabular-nums text-white">
          $
          {producto.precio.toLocaleString(
            "es-AR"
          )}
        </p>

        {!!producto.precio_anterior && (
          <p className="text-11px tabular-nums text-white/30 line-through">
            $
            {producto.precio_anterior.toLocaleString(
              "es-AR"
            )}
          </p>
        )}

        {!!producto.descuento && (
          <p className="mt-0.5 text-10px font-semibold text-green-400">
            -
            {
              producto.descuento
            }
            % OFF
          </p>
        )}
      </div>

      <button
        type="button"
        title={
          producto.activo
            ? "Desactivar producto"
            : "Activar producto"
        }
        aria-label={
          producto.activo
            ? "Desactivar producto"
            : "Activar producto"
        }
        onClick={() =>
          onToggleActivo(
            producto
          )
        }
        className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-11px font-semibold transition-colors cursor-pointer ${
          producto.activo
            ? "border-green-500/20 bg-green-500/10 text-green-400"
            : "border-white/10 bg-white/5 text-white/35"
        }`}
      >
        <span
          className={`size-1.5 rounded-full ${
            producto.activo
              ? "bg-green-400"
              : "bg-white/25"
          }`}
        />

        {producto.activo
          ? "Activo"
          : "Inactivo"}
      </button>

      <div className="flex items-center justify-end gap-1.5">
        {[
          {
            href: `/producto/${producto.slug}`,
            title:
              "Ver producto",
            icon: (
              <Package className="size-3.5" />
            ),
            hover:
              "hover:text-[#4A90B8] hover:border-[#4A90B8]/30",
          },
        ].map((item) => (
          <Link
            key={item.title}
            href={item.href}
            title={item.title}
            className={`flex size-8 items-center justify-center rounded-xl border border-white/8 text-white/50 transition-colors cursor-pointer ${item.hover}`}
          >
            {item.icon}
          </Link>
        ))}

        <button
          type="button"
          title="Editar"
          aria-label="Editar"
          onClick={() =>
            onEdit(producto)
          }
          className="flex size-8 items-center justify-center rounded-xl border border-white/8 text-white/50 transition-colors hover:border-white/20 hover:text-white cursor-pointer"
        >
          <Pencil className="size-3.5" />
        </button>

        <button
          type="button"
          title="Eliminar"
          aria-label="Eliminar"
          onClick={() =>
            onDelete(producto.id)
          }
          className="flex size-8 items-center justify-center rounded-xl border border-white/8 text-white/50 transition-colors hover:border-red-500/30 hover:text-red-400 cursor-pointer"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}