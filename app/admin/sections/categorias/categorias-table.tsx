"use client"

import { FolderOpen } from "lucide-react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

import { CategoriasRow } from "./categorias-row"

interface CategoriasTableProps {
  categorias: SupabaseCategoria[]

  categoryStats: Map<
    number,
    {
      articulos: number
      stock: number
    }
  >

  loading: boolean

  onEdit: (
    categoria: SupabaseCategoria
  ) => void

  onToggleDestacado: (
    categoria: SupabaseCategoria
  ) => void

  onPositionChange: (
    categoria: SupabaseCategoria,
    position: 1 | 2 | 3 | null
  ) => void

  onDelete: (
    id: number
  ) => void
}

const headers = [
  "Producto / Categoría",
  "Artículos",
  "Stock",
  "Destacada",
  "Posición",
  "Acciones",
]

export function CategoriasTable({
  categorias,
  categoryStats,
  loading,
  onEdit,
  onToggleDestacado,
  onPositionChange,
  onDelete,
}: CategoriasTableProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map(
          (_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-2xl border border-white/6 bg-white/2"
            />
          )
        )}
      </div>
    )
  }

  if (!categorias.length) {
    return (
      <div className="rounded-3xl border border-white/7 bg-black p-12 text-center">
        <FolderOpen className="mx-auto mb-3 size-10 text-white/15" />

        <p className="text-sm font-medium text-white/60">
          No hay categorías cargadas.
        </p>

        <p className="mt-1 text-xs text-white/40">
          Creá una categoría para empezar.
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-3xl border border-white/7 bg-black">
      <div className="min-w-admin-categories">
        <div className="grid grid-cols-admin-categories items-center gap-3 border-b border-white/6 bg-black px-5 py-3">
          {headers.map((label) => (
            <span
              key={label}
              className={`text-11px font-semibold uppercase tracking-widest text-white/55 ${
                label === "Producto / Categoría"
                  ? ""
                  : "text-center"
              }`}
            >
              {label}
            </span>
          ))}
        </div>

        {categorias.map(
          (categoria, index) => (
            <CategoriasRow
              key={categoria.id}
              categoria={categoria}
              stats={
                categoryStats.get(
                  categoria.id
                ) || {
                  articulos: 0,
                  stock: 0,
                }
              }
              isLast={
                index ===
                categorias.length -
                  1
              }
              onEdit={onEdit}
              onToggleDestacado={
                onToggleDestacado
              }
              onPositionChange={
                onPositionChange
              }
              onDelete={onDelete}
            />
          )
        )}
      </div>
    </div>
  )
}
