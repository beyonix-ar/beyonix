"use client"

import { Plus, Search } from "lucide-react"

import { AdminSelect, AdminTextInput } from "../../components/admin-controls"

type StockFilter = "todos" | "sin_stock" | "bajo_stock" | "disponible"
type ActiveFilter = "todos" | "activos" | "inactivos"
type FeaturedFilter = "todos" | "destacados" | "normales"

interface ProductosToolbarProps {
  search: string
  categorias: { id: number; nombre: string }[]
  categoryFilter: string
  stockFilter: StockFilter
  activeFilter: ActiveFilter
  featuredFilter: FeaturedFilter
  onCreate: () => void
  onSearchChange: (value: string) => void
  onCategoryFilterChange: (value: string) => void
  onStockFilterChange: (value: StockFilter) => void
  onActiveFilterChange: (value: ActiveFilter) => void
  onFeaturedFilterChange: (value: FeaturedFilter) => void
}

export function ProductosToolbar({
  search,
  categorias,
  categoryFilter,
  stockFilter,
  activeFilter,
  featuredFilter,
  onCreate,
  onSearchChange,
  onCategoryFilterChange,
  onStockFilterChange,
  onActiveFilterChange,
  onFeaturedFilterChange,
}: ProductosToolbarProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="mb-1 text-11px font-bold uppercase tracking-widest text-beyonix-cyan">
            Gestión
          </p>
          <h1 className="text-3xl font-black text-white/95">Productos</h1>
          <p className="mt-2 text-sm text-white/68">
            Catálogo, stock, variantes, imágenes y disponibilidad.
          </p>
        </div>

        <button
          type="button"
          title="Nuevo producto"
          aria-label="Nuevo producto"
          onClick={onCreate}
          className="inline-flex h-12 min-w-160px items-center justify-center gap-2 rounded-2xl bg-white px-6 text-sm font-black text-black transition-all hover:bg-white/90"
        >
          <Plus className="size-4" />
          Nuevo producto
        </button>
      </div>

      <div className="rounded-3xl border border-white/8 bg-beyonix-surface p-4">
        <div className="grid gap-3 lg:grid-cols-admin-product-filters">
          <AdminTextInput
            title="Buscar producto"
            ariaLabel="Buscar producto"
            value={search}
            placeholder="Buscar producto o categoría"
            icon={<Search className="size-4" />}
            onChange={onSearchChange}
          />

          <AdminSelect
            title="Filtrar categoría"
            value={categoryFilter}
            onChange={onCategoryFilterChange}
          >
            <option value="todos">Todas las categorías</option>
            {categorias.map((categoria) => (
              <option key={categoria.id} value={categoria.id}>
                {categoria.nombre}
              </option>
            ))}
          </AdminSelect>

          <AdminSelect
            title="Filtrar stock"
            value={stockFilter}
            onChange={(value) => onStockFilterChange(value as StockFilter)}
          >
            <option value="todos">Todo stock</option>
            <option value="sin_stock">Sin stock</option>
            <option value="bajo_stock">Bajo stock</option>
            <option value="disponible">Disponible</option>
          </AdminSelect>

          <AdminSelect
            title="Filtrar estado"
            value={activeFilter}
            onChange={(value) => onActiveFilterChange(value as ActiveFilter)}
          >
            <option value="todos">Todos</option>
            <option value="activos">Activos</option>
            <option value="inactivos">Inactivos</option>
          </AdminSelect>

          <AdminSelect
            title="Filtrar destacados"
            value={featuredFilter}
            onChange={(value) => onFeaturedFilterChange(value as FeaturedFilter)}
          >
            <option value="todos">Destacados</option>
            <option value="destacados">Solo destacados</option>
            <option value="normales">No destacados</option>
          </AdminSelect>
        </div>
      </div>
    </div>
  )
}
