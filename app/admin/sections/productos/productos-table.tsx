"use client"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

import { Package } from "lucide-react"

import { ProductosRow } from "./productos-row"

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface ProductosTableProps {
  productos: SupabaseProducto[]
  loading: boolean

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

export function ProductosTable({
  productos,
  loading,
  onEdit,
  onDelete,
  onToggleActivo,
}: ProductosTableProps) {
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

  if (productos.length === 0) {
    return (
      <div className="rounded-3xl border border-white/6 bg-[#0A0A0A] p-14 text-center">
        <Package className="size-10 text-white/15 mx-auto mb-4" />

        <p className="text-sm font-medium text-white/50">
          No hay productos cargados.
        </p>

        <p className="text-xs text-white/30 mt-1">
          Creá tu primer producto para empezar.
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
      <div className="grid grid-cols-[2fr_1fr_1fr_110px_120px] gap-4 px-5 py-3 border-b border-white/6 bg-[#0A0A0A]">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">
          Producto
        </span>

        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">
          Categoría
        </span>

        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">
          Precio
        </span>

        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">
          Estado
        </span>

        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35 text-right">
          Acciones
        </span>
      </div>

      {/* Rows */}
      {productos.map((producto, i) => (
        <ProductosRow
          key={producto.id}
          producto={producto}
          isLast={
            i === productos.length - 1
          }
          onEdit={onEdit}
          onDelete={onDelete}
          onToggleActivo={
            onToggleActivo
          }
        />
      ))}
    </div>
  )
}