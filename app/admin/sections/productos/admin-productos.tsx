"use client"

import { useEffect, useState } from "react"

import { useCategorias } from "@/hooks/use-categorias"
import { useSiteSettings } from "@/hooks/use-site-settings"
import { useProductos } from "@/hooks/use-productos"
import { getProductoById } from "@/lib/supabase/queries/productos"
import type { SupabaseProducto } from "@/lib/supabase/types"

import { adminPageClassName, AdminInfoBlock } from "../../components/admin-controls"
import { AdminCategorias } from "../categorias/admin-categorias"
import { ProductoForm } from "./producto-form"
import { ProductosTable } from "./productos-table"
import { ProductosToolbar } from "./productos-toolbar"

type StockFilter = "todos" | "sin_stock" | "bajo_stock" | "disponible"
type ActiveFilter = "todos" | "activos" | "inactivos"
type FeaturedFilter = "todos" | "destacados" | "normales"
type ProductView = "productos" | "categorias"

export function AdminProductos() {
  const { stock: stockSettings } = useSiteSettings()
  const { categorias } = useCategorias()
  const [page, setPage] = useState(1)
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [loadingProductId, setLoadingProductId] = useState<number | null>(null)
  const pageSize = 25
  const [search, setSearch] = useState("")
  const [categorySearch, setCategorySearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("todos")
  const [stockFilter, setStockFilter] = useState<StockFilter>("todos")
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("todos")
  const [featuredFilter, setFeaturedFilter] = useState<FeaturedFilter>("todos")
  const [view, setView] = useState<ProductView>("productos")
  const {
    productos,
    total,
    loading,
    error,
    deleteProducto,
    toggleProductoActivo,
    reloadProductos,
  } = useProductos({
    enabled: view === "productos",
    page,
    pageSize,
    search: debouncedSearch,
    categoryId: categoryFilter === "todos" ? null : Number(categoryFilter),
    stockFilter,
    activeFilter,
    featuredFilter,
    lowStockThreshold: stockSettings.lowStockThreshold,
    availableStockThreshold: stockSettings.availableStockThreshold,
  })

  const [createCategorySignal, setCreateCategorySignal] = useState(0)
  const [editando, setEditando] = useState<SupabaseProducto | null | undefined>(
    undefined
  )

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)

    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [activeFilter, categoryFilter, featuredFilter, stockFilter])

  const handleDelete = async (id: number) => {
    const ok = confirm("¿Eliminar este producto?")
    if (!ok) return
    await deleteProducto(id)
  }

  const handleSaved = async () => {
    await reloadProductos()
    setEditando(undefined)
  }

  const handleEdit = async (producto: SupabaseProducto) => {
    try {
      setLoadingProductId(producto.id)
      setEditando(await getProductoById(producto.id))
    } catch (loadError) {
      console.error("No se pudo cargar el producto completo.", loadError)
    } finally {
      setLoadingProductId(null)
    }
  }

  if (editando !== undefined) {
    return (
      <ProductoForm
        producto={editando}
        onSaved={handleSaved}
        onCancel={() => setEditando(undefined)}
      />
    )
  }

  return (
    <div className={adminPageClassName}>
      <ProductosToolbar
        search={search}
        categorySearch={categorySearch}
        categorias={categorias}
        categoryFilter={categoryFilter}
        stockFilter={stockFilter}
        activeFilter={activeFilter}
        featuredFilter={featuredFilter}
        view={view}
        onSearchChange={setSearch}
        onCategorySearchChange={setCategorySearch}
        onCategoryFilterChange={setCategoryFilter}
        onStockFilterChange={setStockFilter}
        onActiveFilterChange={setActiveFilter}
        onFeaturedFilterChange={setFeaturedFilter}
        onViewChange={setView}
        onCreate={() => setEditando(null)}
        onCreateCategory={() => setCreateCategorySignal((current) => current + 1)}
      />

      {view === "categorias" ? (
        <AdminCategorias
          createSignal={createCategorySignal}
          search={categorySearch}
        />
      ) : (
        <>
          {error && (
            <AdminInfoBlock tone="danger">
              {error}
            </AdminInfoBlock>
          )}
          {loadingProductId !== null && (
            <AdminInfoBlock>
              Cargando el detalle del producto seleccionado…
            </AdminInfoBlock>
          )}

          <ProductosTable
            productos={productos}
            stockSettings={stockSettings}
            loading={loading}
            onEdit={(producto) => void handleEdit(producto)}
            onDelete={handleDelete}
            onToggleActivo={toggleProductoActivo}
          />
          {!loading && total > 0 && (
            <div className="flex flex-col gap-3 rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <p className="font-semibold text-white/55">
                Mostrando {productos.length} de {total} productos
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  className="h-9 cursor-pointer rounded-xl border border-white/12 px-4 text-xs font-black text-white transition hover:border-beyonix-sky/35 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  Anterior
                </button>
                <span className="min-w-24 text-center text-xs font-black text-white/65">
                  Página {page} de {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  className="h-9 cursor-pointer rounded-xl border border-white/12 px-4 text-xs font-black text-white transition hover:border-beyonix-sky/35 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
