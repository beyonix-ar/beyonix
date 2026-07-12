"use client"

import { FolderOpen, Package, Plus, Search } from "lucide-react"

import {
  AdminFiltersBar,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSelect,
  AdminTextInput,
} from "../../components/admin-controls"

type StockFilter = "todos" | "sin_stock" | "bajo_stock" | "disponible"
type ActiveFilter = "todos" | "activos" | "inactivos"
type FeaturedFilter = "todos" | "destacados" | "normales"
type ProductView = "productos" | "categorias"

interface ProductosToolbarProps {
  search: string
  categorySearch: string
  categorias: { id: number; nombre: string }[]
  categoryFilter: string
  stockFilter: StockFilter
  activeFilter: ActiveFilter
  featuredFilter: FeaturedFilter
  view: ProductView
  onCreate: () => void
  onCreateCategory: () => void
  onSearchChange: (value: string) => void
  onCategorySearchChange: (value: string) => void
  onCategoryFilterChange: (value: string) => void
  onStockFilterChange: (value: StockFilter) => void
  onActiveFilterChange: (value: ActiveFilter) => void
  onFeaturedFilterChange: (value: FeaturedFilter) => void
  onViewChange: (value: ProductView) => void
}

export function ProductosToolbar({
  search,
  categorySearch,
  categorias,
  categoryFilter,
  stockFilter,
  activeFilter,
  featuredFilter,
  view,
  onCreate,
  onCreateCategory,
  onSearchChange,
  onCategorySearchChange,
  onCategoryFilterChange,
  onStockFilterChange,
  onActiveFilterChange,
  onFeaturedFilterChange,
  onViewChange,
}: ProductosToolbarProps) {
  const createLabel = view === "productos" ? "Nuevo producto" : "Nueva categoría"
  const createHandler = view === "productos" ? onCreate : onCreateCategory

  return (
    <div className="space-y-4">
      <AdminPageHeader
        eyebrow="Gestión"
        title="Productos"
        description="Catálogo, stock, variantes, imágenes, categorías y disponibilidad."
        actions={
          <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-xl border border-beyonix-blue-light/25 bg-black/35 p-0.5 shadow-inner shadow-black/40">
            <button
              type="button"
              title="Ver productos"
              aria-label="Ver productos"
              onClick={() => onViewChange("productos")}
              className={`inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-black transition-all ${
                view === "productos"
                  ? "border-beyonix-sky/45 bg-beyonix-blue text-beyonix-sky shadow-beyonix-slider"
                  : "border-transparent text-white/62 hover:border-white/10 hover:bg-white/7 hover:text-white"
              }`}
            >
              <Package className="size-3.5" />
              Productos
            </button>
            <button
              type="button"
              title="Ver categorías"
              aria-label="Ver categorías"
              onClick={() => onViewChange("categorias")}
              className={`inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-black transition-all ${
                view === "categorias"
                  ? "border-beyonix-sky/45 bg-beyonix-blue text-beyonix-sky shadow-beyonix-slider"
                  : "border-transparent text-white/62 hover:border-white/10 hover:bg-white/7 hover:text-white"
              }`}
            >
              <FolderOpen className="size-3.5" />
              Categorías
            </button>
          </div>

          <AdminPrimaryButton
            title={createLabel}
            aria-label={createLabel}
            size="lg"
            onClick={createHandler}
            className="min-w-160px"
          >
            <Plus className="size-4" />
            {createLabel}
          </AdminPrimaryButton>
        </div>
        }
      />

      <AdminFiltersBar>
        {view === "productos" ? (
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-admin-product-filters">
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
              onChange={(value) =>
                onFeaturedFilterChange(value as FeaturedFilter)
              }
            >
              <option value="todos">Todos los productos</option>
              <option value="destacados">Solo destacados</option>
              <option value="normales">No destacados</option>
            </AdminSelect>
          </div>
        ) : (
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="w-full max-w-md">
              <AdminTextInput
                title="Buscar categoría"
                ariaLabel="Buscar categoría"
                value={categorySearch}
                placeholder="Buscar categoría"
                icon={<Search className="size-4" />}
                onChange={onCategorySearchChange}
              />
            </div>

            <p className="text-xs font-semibold text-white/45 lg:text-right">
              Gestioná nombres, imágenes, destacados y posiciones desde una
              vista más compacta.
            </p>
          </div>
        )}
      </AdminFiltersBar>
    </div>
  )
}
