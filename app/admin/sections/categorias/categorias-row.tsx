"use client"

import {
  Pencil,
  Trash2,
} from "lucide-react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"
import { SITE_SETTINGS } from "@/config/site-settings"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface CategoriasRowProps {
  categoria: SupabaseCategoria
  stats: {
    articulos: number
    stock: number
  }

  isLast?: boolean

  onEdit: (
    categoria: SupabaseCategoria
  ) => void

  onDelete: (
    id: number
  ) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function CategoriasRow({
  categoria,
  stats,
  isLast,
  onEdit,
  onDelete,
}: CategoriasRowProps) {
  return (
    <div
      className={`grid grid-cols-admin-categories gap-4 bg-black px-5 py-4 items-center transition-colors hover:bg-[#02070d] ${
        !isLast
          ? "border-b border-white/5"
          : ""
      }`}
    >
      {/* Nombre */}
      <div className="min-w-0">
        <p className="truncate text-base font-bold text-white">
          {categoria.nombre}
        </p>
      </div>

      <p className="text-base font-bold text-white">
        {stats.articulos}
      </p>

      <p
        className={`text-base font-bold ${
          stats.stock <= 0
            ? "text-red-400"
            : stats.stock <= SITE_SETTINGS.stock.criticalStockThreshold
              ? "text-red-400"
              : stats.stock <= SITE_SETTINGS.stock.lowStockThreshold
              ? "text-amber-400"
              : "text-green-400"
        }`}
      >
        {stats.stock}
      </p>

      {/* Acciones */}
      <div className="flex items-center justify-center gap-1.5">
        <button
          type="button"
          title="Editar categoría"
          aria-label="Editar categoría"
          onClick={() =>
            onEdit(categoria)
          }
          className="size-8 rounded-xl border border-white/8 flex items-center justify-center text-white/60 hover:text-white hover:border-white/20 transition-colors cursor-pointer"
        >
          <Pencil className="size-3.5" />
        </button>

        <button
          type="button"
          title="Eliminar categoría"
          aria-label="Eliminar categoría"
          onClick={() =>
            onDelete(categoria.id)
          }
          className="size-8 rounded-xl border border-white/8 flex items-center justify-center text-white/60 hover:text-red-400 hover:border-red-500/30 transition-colors cursor-pointer"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
