"use client"

import { ArrowDown, ArrowUp, ArrowUpDown, Package } from "lucide-react"

import type { SupabaseProducto } from "@/lib/supabase/types"
import type { StockSettings } from "@/lib/site-settings"

import {
  AdminEmptyState,
  AdminSkeleton,
  AdminTable,
} from "../../components/admin-controls"
import type {
  ProductSortKey,
  SortDirection,
} from "./admin-productos"
import { ProductosRow } from "./productos-row"

interface ProductosTableProps {
  productos: SupabaseProducto[]
  stockSettings: StockSettings
  loading: boolean
  sortBy: ProductSortKey
  sortDirection: SortDirection
  onSort: (key: ProductSortKey) => void
  onEdit: (producto: SupabaseProducto) => void
  onDelete: (id: number) => void
  onToggleActivo: (producto: SupabaseProducto) => void
}

interface SortableHeaderProps {
  label: string
  sortKey: ProductSortKey
  activeKey: ProductSortKey
  direction: SortDirection
  centered?: boolean
  onSort: (key: ProductSortKey) => void
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  centered = false,
  onSort,
}: SortableHeaderProps) {
  const active = activeKey === sortKey
  const Icon = active
    ? direction === "asc"
      ? ArrowUp
      : ArrowDown
    : ArrowUpDown
  const nextDirection = active && direction === "asc" ? "descendente" : "ascendente"

  return (
    <span
      className={`flex items-center gap-1.5 text-10px font-semibold uppercase tracking-widest text-white/45 ${
        centered ? "justify-center text-center" : ""
      }`}
    >
      {label}
      <button
        type="button"
        aria-label={`Ordenar ${label.toLocaleLowerCase("es")} de forma ${nextDirection}`}
        title={`Ordenar por ${label}`}
        onClick={() => onSort(sortKey)}
        className={`admin-column-sort-button flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md border transition ${
          active
            ? "border-beyonix-sky/40 bg-beyonix-blue/30 text-beyonix-sky"
            : "border-white/9 bg-white/4 text-white/38 hover:border-beyonix-sky/30 hover:text-white/75"
        }`}
      >
        <Icon className="size-3" />
      </button>
    </span>
  )
}

export function ProductosTable({
  productos,
  stockSettings,
  loading,
  sortBy,
  sortDirection,
  onSort,
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
        title="No hay productos para mostrar."
        description="No encontramos productos con los filtros elegidos. Probá cambiar o limpiar algún filtro."
      />
    )
  }

  return (
    <AdminTable className="admin-products-table">
      <div className="admin-products-table-header grid grid-cols-admin-products gap-3 border-b border-white/6 bg-black px-4 py-2.5">
        <SortableHeader
          label="Producto"
          sortKey="nombre"
          activeKey={sortBy}
          direction={sortDirection}
          onSort={onSort}
        />
        <SortableHeader
          label="Cantidad"
          sortKey="stock"
          activeKey={sortBy}
          direction={sortDirection}
          centered
          onSort={onSort}
        />
        <SortableHeader
          label="SKU"
          sortKey="sku"
          activeKey={sortBy}
          direction={sortDirection}
          centered
          onSort={onSort}
        />
        <SortableHeader
          label="Color"
          sortKey="color"
          activeKey={sortBy}
          direction={sortDirection}
          centered
          onSort={onSort}
        />
        {["Stock", "Precio", "Estado", "Acciones"].map((label) => (
          <span
            key={label}
            className="text-center text-10px font-semibold uppercase tracking-widest text-white/45"
          >
            {label}
          </span>
        ))}
      </div>

      {productos.map((producto, index) => (
        <ProductosRow
          key={producto.id}
          producto={producto}
          stockSettings={stockSettings}
          visualIndex={index}
          isLast={index === productos.length - 1}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggleActivo={onToggleActivo}
        />
      ))}
    </AdminTable>
  )
}
