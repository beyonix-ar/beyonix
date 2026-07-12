"use client"

import { useMemo, useState } from "react"

import { SITE_SETTINGS } from "@/config/site-settings"
import { useProductos } from "@/hooks/use-productos"
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

function getStockTotal(producto: SupabaseProducto) {
  const variantes = producto.producto_variantes ?? []
  if (!variantes.length) return producto.stock ?? 0

  return variantes.reduce((total, variante) => total + (variante.stock ?? 0), 0)
}

export function AdminProductos() {
  const {
    productos,
    loading,
    error,
    deleteProducto,
    toggleProductoActivo,
    reloadProductos,
  } = useProductos()

  const [search, setSearch] = useState("")
  const [categorySearch, setCategorySearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("todos")
  const [stockFilter, setStockFilter] = useState<StockFilter>("todos")
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("todos")
  const [featuredFilter, setFeaturedFilter] = useState<FeaturedFilter>("todos")
  const [view, setView] = useState<ProductView>("productos")
  const [createCategorySignal, setCreateCategorySignal] = useState(0)
  const [editando, setEditando] = useState<SupabaseProducto | null | undefined>(
    undefined
  )

  const categorias = useMemo(() => {
    const byId = new Map<number, string>()
    productos.forEach((producto) => {
      if (producto.categoria_id && producto.categorias?.nombre) {
        byId.set(producto.categoria_id, producto.categorias.nombre)
      }
    })

    return Array.from(byId.entries()).map(([id, nombre]) => ({ id, nombre }))
  }, [productos])

  const productosFiltrados = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()

    return productos.filter((producto) => {
      const stock = getStockTotal(producto)
      const matchesSearch = [
        producto.nombre,
        producto.slug,
        producto.categorias?.nombre ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch)
      const matchesCategory =
        categoryFilter === "todos" ||
        String(producto.categoria_id) === categoryFilter
      const matchesStock =
        stockFilter === "todos" ||
        (stockFilter === "sin_stock" && stock <= 0) ||
        (stockFilter === "bajo_stock" &&
          stock > 0 &&
          stock <= SITE_SETTINGS.stock.lowStockThreshold) ||
        (stockFilter === "disponible" &&
          stock > SITE_SETTINGS.stock.lowStockThreshold)
      const matchesActive =
        activeFilter === "todos" ||
        (activeFilter === "activos" && producto.activo) ||
        (activeFilter === "inactivos" && !producto.activo)
      const matchesFeatured =
        featuredFilter === "todos" ||
        (featuredFilter === "destacados" && producto.destacado) ||
        (featuredFilter === "normales" && !producto.destacado)

      return (
        matchesSearch &&
        matchesCategory &&
        matchesStock &&
        matchesActive &&
        matchesFeatured
      )
    })
  }, [
    activeFilter,
    categoryFilter,
    featuredFilter,
    productos,
    search,
    stockFilter,
  ])

  const handleDelete = async (id: number) => {
    const ok = confirm("¿Eliminar este producto?")
    if (!ok) return
    await deleteProducto(id)
  }

  const handleSaved = async () => {
    await reloadProductos()
    setEditando(undefined)
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

          <ProductosTable
            productos={productosFiltrados}
            loading={loading}
            onEdit={(producto) => setEditando(producto)}
            onDelete={handleDelete}
            onToggleActivo={toggleProductoActivo}
          />
        </>
      )}
    </div>
  )
}
