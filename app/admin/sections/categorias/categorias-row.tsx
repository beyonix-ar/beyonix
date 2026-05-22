"use client"

import {
  Pencil,
  Trash2,
} from "lucide-react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface CategoriasRowProps {
  categoria: SupabaseCategoria

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
  isLast,
  onEdit,
  onDelete,
}: CategoriasRowProps) {
  return (
    <div
      className={`grid grid-cols-[1fr_1fr_120px] gap-4 px-5 py-4 items-center transition-colors hover:bg-white/2 ${
        !isLast
          ? "border-b border-white/5"
          : ""
      }`}
    >
      {/* Nombre */}
      <div className="min-w-0">
        <p className="text-sm font-medium text-white truncate">
          {categoria.nombre}
        </p>
      </div>

      {/* Slug */}
      <div className="min-w-0">
        <p className="text-sm text-white/45 truncate">
          {categoria.slug}
        </p>
      </div>

      {/* Acciones */}
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          title="Editar categoría"
          onClick={() =>
            onEdit(categoria)
          }
          className="size-8 rounded-xl border border-white/8 flex items-center justify-center text-white/50 hover:text-white hover:border-white/20 transition-colors cursor-pointer"
        >
          <Pencil className="size-3.5" />
        </button>

        <button
          type="button"
          title="Eliminar categoría"
          onClick={() =>
            onDelete(categoria.id)
          }
          className="size-8 rounded-xl border border-white/8 flex items-center justify-center text-white/50 hover:text-red-400 hover:border-red-500/30 transition-colors cursor-pointer"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  )
}