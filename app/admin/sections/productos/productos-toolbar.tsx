"use client"

import { FolderOpen, Package, Plus, Search } from "lucide-react"

import type { ProductColorOption } from "@/lib/supabase/queries/productos"

import {
  AdminFiltersBar,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSelect,
  AdminTextInput,
} from "../../components/admin-controls"

type StockFilter =
  | "todos"
  | "sin_stock"
  | "bajo_stock"
  | "disponible"
  | "mayor_que"
  | "menor_que"
  | "entre"
type ActiveFilter = "todos" | "activos" | "inactivos"
type FeaturedFilter = "todos" | "destacados" | "normales"
type ProductView = "productos" | "categorias"

interface ProductosToolbarProps {
  search: string
  colorSearch: string
  colorOptions: ProductColorOption[]
  stockFrom: string
  stockTo: string
  categorySearch: string
  categorias: { id: number; nombre: string }[]
  categoryFilter: string
  stockFilter: StockFilter
  activeFilter: ActiveFilter
  featuredFilter: FeaturedFilter
  view: ProductView
  onCreateCategory: () => void
  onSearchChange: (value: string) => void
  onColorSearchChange: (value: string) => void
  onStockFromChange: (value: string) => void
  onStockToChange: (value: string) => void
  onCategorySearchChange: (value: string) => void
  onCategoryFilterChange: (value: string) => void
  onStockFilterChange: (value: StockFilter) => void
  onActiveFilterChange: (value: ActiveFilter) => void
  onFeaturedFilterChange: (value: FeaturedFilter) => void
  onViewChange: (value: ProductView) => void
}

export function ProductosToolbar({
  search,
  colorSearch,
  colorOptions,
  stockFrom,
  stockTo,
  categorySearch,
  categorias,
  categoryFilter,
  stockFilter,
  activeFilter,
  featuredFilter,
  view,
  onCreateCategory,
  onSearchChange,
  onColorSearchChange,
  onStockFromChange,
  onStockToChange,
  onCategorySearchChange,
  onCategoryFilterChange,
  onStockFilterChange,
  onActiveFilterChange,
  onFeaturedFilterChange,
  onViewChange,
}: ProductosToolbarProps) {
  return (
    <div className="space-y-4">
      <AdminPageHeader
        eyebrow="Gestión"
        title="Productos"
        description="Catálogo y stock real calculado desde Compras, Pedidos y devoluciones aprobadas."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-xl border border-beyonix-blue-light/25 bg-black/35 p-0.5 shadow-inner shadow-black/40">
              <button
                type="button"
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

            {view === "categorias" && (
              <AdminPrimaryButton
                title="Nueva categoría"
                aria-label="Nueva categoría"
                size="lg"
                onClick={onCreateCategory}
                className="min-w-160px"
              >
                <Plus className="size-4" />
                Nueva categoría
              </AdminPrimaryButton>
            )}
          </div>
        }
      />

      <AdminFiltersBar className="p-3">
        {view === "productos" ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
              <AdminTextInput
                title="Buscar producto"
                ariaLabel="Buscar producto"
                value={search}
                placeholder="Nombre o SKU"
                icon={<Search className="size-4" />}
                onChange={onSearchChange}
              />

              <AdminSelect
                title="Filtrar por color"
                value={colorSearch}
                centered
                optionClassName="admin-products-filter-option"
                onChange={onColorSearchChange}
              >
                <option value="">Todos los colores</option>
                {colorOptions.map((color) => (
                  <option key={color.value} value={color.value}>
                    <span className="inline-flex min-w-0 items-center justify-center gap-2">
                      <span
                        className="size-3.5 shrink-0 rounded-full border border-white/30"
                        style={{ backgroundColor: color.hex }}
                      />
                      <span className="truncate">{color.label}</span>
                    </span>
                  </option>
                ))}
              </AdminSelect>

              <AdminSelect
                title="Filtrar categoría"
                value={categoryFilter}
                centered
                optionClassName="admin-products-filter-option"
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
                title="Filtrar cantidad"
                value={stockFilter}
                centered
                optionClassName="admin-products-filter-option"
                onChange={(value) => onStockFilterChange(value as StockFilter)}
              >
                <option value="todos">Cualquier cantidad</option>
                <option value="sin_stock">Sin stock</option>
                <option value="bajo_stock">Bajo stock</option>
                <option value="disponible">Disponible</option>
                <option value="mayor_que">Más de…</option>
                <option value="menor_que">Menos de…</option>
                <option value="entre">Entre…</option>
              </AdminSelect>

              <AdminSelect
                title="Filtrar estado"
                value={activeFilter}
                centered
                optionClassName="admin-products-filter-option"
                onChange={(value) =>
                  onActiveFilterChange(value as ActiveFilter)
                }
              >
                <option value="todos">Todos</option>
                <option value="activos">Activos</option>
                <option value="inactivos">Inactivos</option>
              </AdminSelect>

              <AdminSelect
                title="Filtrar destacados"
                value={featuredFilter}
                centered
                optionClassName="admin-products-filter-option"
                onChange={(value) =>
                  onFeaturedFilterChange(value as FeaturedFilter)
                }
              >
                <option value="todos">Todos los productos</option>
                <option value="destacados">Solo destacados</option>
                <option value="normales">No destacados</option>
              </AdminSelect>
            </div>

            {(stockFilter === "mayor_que" ||
              stockFilter === "menor_que" ||
              stockFilter === "entre") && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
                <div
                  className={`grid gap-3 2xl:col-start-4 ${
                    stockFilter === "entre"
                      ? "grid-cols-2 2xl:col-span-2"
                      : "2xl:col-span-1"
                  }`}
                >
                  {(stockFilter === "mayor_que" ||
                    stockFilter === "entre") && (
                    <AdminTextInput
                      title={
                        stockFilter === "entre" ? "Cantidad mínima" : "Más de"
                      }
                      ariaLabel={
                        stockFilter === "entre" ? "Cantidad mínima" : "Más de"
                      }
                      type="number"
                      inputMode="numeric"
                      value={stockFrom}
                      placeholder={
                        stockFilter === "entre" ? "Cantidad mínima" : "Más de"
                      }
                      onChange={onStockFromChange}
                    />
                  )}

                  {(stockFilter === "menor_que" ||
                    stockFilter === "entre") && (
                    <AdminTextInput
                      title={
                        stockFilter === "entre" ? "Cantidad máxima" : "Menos de"
                      }
                      ariaLabel={
                        stockFilter === "entre" ? "Cantidad máxima" : "Menos de"
                      }
                      type="number"
                      inputMode="numeric"
                      value={stockTo}
                      placeholder={
                        stockFilter === "entre" ? "Cantidad máxima" : "Menos de"
                      }
                      onChange={onStockToChange}
                    />
                  )}
                </div>
              </div>
            )}
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
