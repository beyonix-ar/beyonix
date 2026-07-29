"use client"

import { useEffect, useMemo, useState } from "react"
import { ImageIcon } from "lucide-react"

import { useCategorias } from "@/hooks/use-categorias"
import { useProductColors } from "@/hooks/use-product-colors"
import { useSiteSettings } from "@/hooks/use-site-settings"
import { useProductos } from "@/hooks/use-productos"
import { getProductoById } from "@/lib/supabase/queries/productos"
import type { ProductColorOption } from "@/lib/supabase/queries/productos"
import type { SupabaseProducto } from "@/lib/supabase/types"

import {
  adminPageClassName,
  AdminDangerButton,
  AdminInfoBlock,
  AdminModal,
  AdminSecondaryButton,
} from "../../components/admin-controls"
import { AdminCategorias } from "../categorias/admin-categorias"
import { ProductoForm } from "./producto-form"
import { ProductosTable } from "./productos-table"
import { ProductosToolbar } from "./productos-toolbar"

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
export type ProductSortKey = "nombre" | "stock" | "sku" | "color"
export type SortDirection = "asc" | "desc"

function parseStockValue(value: string) {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function getPrimaryColor(product: SupabaseProducto) {
  return [...(product.producto_variantes ?? [])]
    .sort((a, b) => a.orden - b.orden || a.id - b.id)[0]
    ?.nombre.trim() ?? ""
}

function mergeProductColors(
  storedColors: ProductColorOption[],
  products: SupabaseProducto[],
) {
  const colors = new Map(
    storedColors.map((color) => [color.hex.toLocaleLowerCase("es"), color]),
  )

  for (const product of products) {
    for (const variant of product.producto_variantes ?? []) {
      const label = variant.nombre?.trim()
      const hex = variant.color_hex?.trim()
      if (!label || !hex) continue

      const key = hex.toLocaleLowerCase("es")
      if (!colors.has(key)) {
        colors.set(key, { value: hex, label, hex })
      }
    }
  }

  return [...colors.values()].sort((left, right) =>
    left.label.localeCompare(right.label, "es", { sensitivity: "base" }),
  )
}

export function AdminProductos() {
  const { stock: stockSettings } = useSiteSettings()
  const { categorias } = useCategorias()
  const storedColorOptions = useProductColors()
  const [page, setPage] = useState(1)
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [debouncedColorSearch, setDebouncedColorSearch] = useState("")
  const [debouncedStockFrom, setDebouncedStockFrom] = useState<number | null>(null)
  const [debouncedStockTo, setDebouncedStockTo] = useState<number | null>(null)
  const [loadingProductId, setLoadingProductId] = useState<number | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SupabaseProducto | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const pageSize = 25
  const [search, setSearch] = useState("")
  const [colorSearch, setColorSearch] = useState("")
  const [stockFrom, setStockFrom] = useState("")
  const [stockTo, setStockTo] = useState("")
  const [categorySearch, setCategorySearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("todos")
  const [stockFilter, setStockFilter] = useState<StockFilter>("todos")
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("todos")
  const [featuredFilter, setFeaturedFilter] = useState<FeaturedFilter>("todos")
  const [sortBy, setSortBy] = useState<ProductSortKey>("nombre")
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc")
  const [view, setView] = useState<ProductView>("productos")
  const {
    productos,
    total,
    loading,
    error,
    actionMessage,
    actionError,
    deleteProducto,
    toggleProductoActivo,
    reloadProductos,
  } = useProductos({
    enabled: view === "productos",
    page,
    pageSize,
    search: debouncedSearch,
    colorSearch: debouncedColorSearch,
    categoryId: categoryFilter === "todos" ? null : Number(categoryFilter),
    stockFilter,
    stockFrom: debouncedStockFrom,
    stockTo: debouncedStockTo,
    activeFilter,
    featuredFilter,
    sortBy,
    sortDirection,
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
      setDebouncedColorSearch(colorSearch)
      setDebouncedStockFrom(parseStockValue(stockFrom))
      setDebouncedStockTo(parseStockValue(stockTo))
      setPage(1)
    }, 300)

    return () => window.clearTimeout(timer)
  }, [colorSearch, search, stockFrom, stockTo])

  useEffect(() => {
    setPage(1)
  }, [
    activeFilter,
    categoryFilter,
    featuredFilter,
    sortBy,
    sortDirection,
    stockFilter,
  ])

  const displayedProducts = useMemo(() => {
    if (sortBy !== "color") return productos

    return [...productos].sort((left, right) => {
      const comparison = getPrimaryColor(left).localeCompare(
        getPrimaryColor(right),
        "es",
        { sensitivity: "base" },
      )
      return sortDirection === "asc" ? comparison : -comparison
    })
  }, [productos, sortBy, sortDirection])

  const colorOptions = useMemo(
    () => mergeProductColors(storedColorOptions, productos),
    [productos, storedColorOptions],
  )

  const handleSort = (key: ProductSortKey) => {
    if (sortBy === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"))
      return
    }

    setSortBy(key)
    setSortDirection("asc")
  }

  const handleDelete = (id: number) => {
    const product = productos.find((item) => item.id === id)
    if (product) setPendingDelete(product)
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeletingId(pendingDelete.id)
    const deleted = await deleteProducto(pendingDelete.id, true)
    setDeletingId(null)
    if (deleted) setPendingDelete(null)
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
        colorSearch={colorSearch}
        colorOptions={colorOptions}
        stockFrom={stockFrom}
        stockTo={stockTo}
        categorySearch={categorySearch}
        categorias={categorias}
        categoryFilter={categoryFilter}
        stockFilter={stockFilter}
        activeFilter={activeFilter}
        featuredFilter={featuredFilter}
        view={view}
        onSearchChange={setSearch}
        onColorSearchChange={setColorSearch}
        onStockFromChange={setStockFrom}
        onStockToChange={setStockTo}
        onCategorySearchChange={setCategorySearch}
        onCategoryFilterChange={setCategoryFilter}
        onStockFilterChange={setStockFilter}
        onActiveFilterChange={setActiveFilter}
        onFeaturedFilterChange={setFeaturedFilter}
        onViewChange={setView}
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
          {actionError && (
            <AdminInfoBlock tone="danger">
              {actionError}
            </AdminInfoBlock>
          )}
          {actionMessage && (
            <AdminInfoBlock>
              {actionMessage}
            </AdminInfoBlock>
          )}
          {loadingProductId !== null && (
            <AdminInfoBlock>
              Cargando el detalle del producto seleccionado…
            </AdminInfoBlock>
          )}

          <ProductosTable
            productos={displayedProducts}
            stockSettings={stockSettings}
            loading={loading}
            sortBy={sortBy}
            sortDirection={sortDirection}
            onSort={handleSort}
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

      <AdminModal
        open={Boolean(pendingDelete)}
        compact
        title="Eliminar producto"
        onClose={() => {
          if (deletingId === null) setPendingDelete(null)
        }}
        footer={
          <div className="flex justify-center gap-2">
            <AdminSecondaryButton
              size="sm"
              disabled={deletingId !== null}
              onClick={() => setPendingDelete(null)}
            >
              Cancelar
            </AdminSecondaryButton>
            <AdminDangerButton
              size="sm"
              disabled={!pendingDelete || deletingId !== null}
              onClick={() => void confirmDelete()}
            >
              {deletingId !== null ? "Eliminando…" : "Eliminar"}
            </AdminDangerButton>
          </div>
        }
      >
        <div className="flex items-center justify-center gap-3 rounded-xl border border-white/9 bg-linear-to-b from-white/4 to-transparent px-4 py-3.5">
          <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white">
            {pendingDelete?.imagen_principal ? (
              <img
                alt={pendingDelete.nombre}
                src={pendingDelete.imagen_principal}
                className="h-full w-full object-cover"
              />
            ) : (
              <ImageIcon className="size-4 text-black/25" />
            )}
          </span>
          <div className="min-w-0 max-w-[70%] text-left">
            <p className="truncate text-base font-black leading-5 text-white">
              {pendingDelete?.nombre}
            </p>
            <span className="mt-1.5 inline-flex rounded-full border border-white/9 bg-black/25 px-2 py-0.5 text-10px font-black uppercase tracking-wider text-white/48">
              {pendingDelete?.stock ?? 0}{" "}
              {Math.abs(pendingDelete?.stock ?? 0) === 1 ? "unidad" : "unidades"}
            </span>
          </div>
        </div>
        <div className="mt-3 px-2 text-center text-xs leading-5 text-white/52">
          <p>
            Se borrarán el producto, sus compras, ventas importadas,
            devoluciones y movimientos de stock.
          </p>
          <p className="mt-1.5 text-xs font-bold text-red-300/82">
            Esta acción no se puede deshacer.
          </p>
        </div>
      </AdminModal>
    </div>
  )
}
