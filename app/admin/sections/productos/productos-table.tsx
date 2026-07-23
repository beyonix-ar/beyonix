"use client"

import { Package } from "lucide-react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"
import type { StockSettings } from "@/lib/site-settings"

import {
  AdminEmptyState,
  AdminSkeleton,
  AdminTable,
} from "../../components/admin-controls"
import { ProductosRow } from "./productos-row"

interface ProductosTableProps {
  productos: SupabaseProducto[]
  stockSettings: StockSettings

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
  stockSettings,
  loading,
  onEdit,
  onDelete,
  onToggleActivo,
}: ProductosTableProps) {
  if (loading) {
    return <AdminSkeleton rows={5} />
  }

  if (!productos.length) {
    return (
      <AdminEmptyState
        icon={<Package className="size-5" />}
        title="No hay productos cargados."
        description="Creá tu primer producto para empezar."
      />
    )
  }

  return (
    <AdminTable className="admin-products-table">
      <div className="admin-products-table-header grid grid-cols-admin-products gap-4 border-b border-white/6 bg-black px-5 py-3">
        {[
          "Producto",
          "Categoría",
          "Precio",
          "Cuotas",
          "Estado",
          "Acciones",
        ].map((label) => (
          <span
            key={label}
            className={`text-10px font-semibold uppercase tracking-widest text-white/45 ${
              label ===
              "Cuotas" ||
              label ===
              "Estado" ||
              label ===
              "Acciones"
                ? "text-center"
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
            stockSettings={stockSettings}
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
    </AdminTable>
  )
}
