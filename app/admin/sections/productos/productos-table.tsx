"use client"

import { Package } from "lucide-react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

import { ProductosRow } from "./productos-row"

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

export function ProductosTable({
  productos,
  loading,
  onEdit,
  onDelete,
  onToggleActivo,
}: ProductosTableProps) {
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

  if (!productos.length) {
    return (
      <div className="rounded-3xl border border-white/6 bg-[#0A0A0A] p-14 text-center">
        <Package className="mx-auto mb-4 size-10 text-white/15" />

        <p className="text-sm font-medium text-white/50">
          No hay productos
          cargados.
        </p>

        <p className="mt-1 text-xs text-white/30">
          Creá tu primer
          producto para empezar.
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-3xl border border-white/7">
      <div className="grid grid-cols-[2fr_1fr_1fr_110px_120px] gap-4 border-b border-white/6 bg-[#0A0A0A] px-5 py-3">
        {[
          "Producto",
          "Categoría",
          "Precio",
          "Estado",
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

      {productos.map(
        (producto, index) => (
          <ProductosRow
            key={producto.id}
            producto={producto}
            isLast={
              index ===
              productos.length -
                1
            }
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleActivo={
              onToggleActivo
            }
          />
        )
      )}
    </div>
  )
}