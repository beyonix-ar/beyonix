"use client"

import { FolderOpen } from "lucide-react"

import type {
  SupabaseCategoria,
} from "@/lib/supabase/types"

import { CategoriasRow } from "./categorias-row"

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

export function CategoriasTable({
  categorias,
  loading,
  onEdit,
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
      <div className="rounded-3xl border border-white/7 bg-[#0A0A0A] p-12 text-center">
        <FolderOpen className="mx-auto mb-3 size-10 text-white/15" />

        <p className="text-sm font-medium text-white/50">
          No hay categorías
          cargadas.
        </p>

        <p className="mt-1 text-xs text-white/30">
          Creá una categoría para
          empezar.
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-3xl border border-white/7">
      <div className="grid grid-cols-[1fr_1fr_120px] gap-4 border-b border-white/6 bg-[#0A0A0A] px-5 py-3">
        {[
          "Nombre",
          "Slug",
          "Acciones",
        ].map((label) => (
          <span
            key={label}
            className={`text-10px font-semibold uppercase tracking-[0.2em] text-white/35 ${
              label ===
              "Acciones"
                ? "text-right"
                : ""
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
            isLast={
              index ===
              categorias.length -
                1
            }
            onEdit={onEdit}
            onDelete={onDelete}
          />
        )
      )}
    </div>
  )
}