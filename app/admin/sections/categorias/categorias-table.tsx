"use client"

import { FolderOpen } from "lucide-react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

import { CategoriasRow } from "./categorias-row"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface CategoriasTableProps {
  categorias: SupabaseCategoria[]

  loading: boolean

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

export function CategoriasTable({
  categorias,
  loading,
  onEdit,
  onDelete,
}: CategoriasTableProps) {
  // ───────────────────────────────────────────────────────────────────────────
  // Loading
  // ───────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className="h-16 rounded-2xl border border-white/6 bg-white/2 animate-pulse"
          />
        ))}
      </div>
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Empty
  // ───────────────────────────────────────────────────────────────────────────

  if (categorias.length === 0) {
    return (
      <div className="rounded-3xl border border-white/7 bg-[#0A0A0A] p-12 text-center">
        <FolderOpen className="size-10 text-white/15 mx-auto mb-3" />

        <p className="text-sm font-medium text-white/50">
          No hay categorías cargadas.
        </p>

        <p className="text-xs text-white/30 mt-1">
          Creá una categoría para empezar.
        </p>
      </div>
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Table
  // ───────────────────────────────────────────────────────────────────────────

  return (
    <div className="rounded-3xl border border-white/7 overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[1fr_1fr_120px] gap-4 px-5 py-3 border-b border-white/6 bg-[#0A0A0A]">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">
          Nombre
        </span>

        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">
          Slug
        </span>

        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35 text-right">
          Acciones
        </span>
      </div>

      {/* Rows */}
      {categorias.map((categoria, i) => (
        <CategoriasRow
          key={categoria.id}
          categoria={categoria}
          isLast={
            i === categorias.length - 1
          }
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}