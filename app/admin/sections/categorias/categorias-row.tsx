"use client"

import { Pencil, Star, Trash2 } from "lucide-react"

import { AdminSelect } from "@/app/admin/components/admin-controls"
import { SITE_SETTINGS } from "@/config/site-settings"
import type { SupabaseCategoria } from "@/lib/supabase/types"

interface CategoriasRowProps {
  categoria: SupabaseCategoria
  stats: {
    articulos: number
    stock: number
  }

  isLast?: boolean

  onEdit: (categoria: SupabaseCategoria) => void

  onToggleDestacado: (categoria: SupabaseCategoria) => void

  onPositionChange: (
    categoria: SupabaseCategoria,
    position: 1 | 2 | 3 | null
  ) => void

  onDelete: (id: number) => void
}

export function CategoriasRow({
  categoria,
  stats,
  isLast,
  onEdit,
  onToggleDestacado,
  onPositionChange,
  onDelete,
}: CategoriasRowProps) {
  const isFeatured = categoria.destacado === true

  return (
    <div
      className={`group grid grid-cols-admin-categories items-center gap-3 bg-black px-5 py-3 transition-all hover:bg-beyonix-blue/20 ${
        !isLast ? "border-b border-white/5" : ""
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-base font-bold text-white">
          {categoria.nombre}
        </p>
        <p className="mt-0.5 truncate text-xs text-white/38">
          {categoria.slug}
        </p>
      </div>

      <p className="text-center text-sm font-bold text-white">
        {stats.articulos}
      </p>

      <p
        className={`text-center text-sm font-bold ${
          stats.stock <= SITE_SETTINGS.stock.criticalStockThreshold
            ? "text-red-400"
            : stats.stock <= SITE_SETTINGS.stock.lowStockThreshold
            ? "text-amber-400"
            : "text-green-400"
        }`}
      >
        {stats.stock}
      </p>

      <div className="flex justify-center">
        <button
          type="button"
          title={isFeatured ? "Quitar destacada" : "Marcar destacada"}
          aria-label={
            isFeatured
              ? "Quitar categoría destacada"
              : "Marcar categoría destacada"
          }
          onClick={() => onToggleDestacado(categoria)}
          className={`flex size-8 cursor-pointer items-center justify-center rounded-xl border transition-all hover:-translate-y-0.5 ${
            isFeatured
              ? "border-beyonix-blue-light/45 bg-beyonix-blue/25 text-beyonix-cyan"
              : "border-white/8 text-white/28 hover:border-beyonix-blue-light/30 hover:text-white/55"
          }`}
        >
          <Star
            className={`size-3.5 ${isFeatured ? "fill-beyonix-cyan/70" : ""}`}
          />
        </button>
      </div>

      <div className="flex justify-center">
        {isFeatured ? (
          <div className="w-20">
            <AdminSelect
              title="Posición destacada"
              ariaLabel={`Posición destacada de ${categoria.nombre}`}
              value={String(categoria.posicion_destacada ?? "")}
              compact
              centered
              onChange={(value) =>
                onPositionChange(
                  categoria,
                  value ? (Number(value) as 1 | 2 | 3) : null
                )
              }
            >
              <option value="">-</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </AdminSelect>
          </div>
        ) : (
          <span className="text-sm font-semibold text-white/28">-</span>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          title="Editar categoría"
          aria-label="Editar categoría"
          onClick={() => onEdit(categoria)}
          className="flex size-8 cursor-pointer items-center justify-center rounded-xl border border-white/8 text-white/60 transition-all hover:-translate-y-0.5 hover:border-beyonix-blue-light/35 hover:bg-beyonix-blue/20 hover:text-white"
        >
          <Pencil className="size-3.5" />
        </button>

        <button
          type="button"
          title="Eliminar categoría"
          aria-label="Eliminar categoría"
          onClick={() => onDelete(categoria.id)}
          className="flex size-8 cursor-pointer items-center justify-center rounded-xl border border-white/8 text-white/60 transition-all hover:-translate-y-0.5 hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
