"use client"

import { useEffect, useMemo, useState } from "react"
import Image from "next/image"
import { Check, ImageIcon, Search } from "lucide-react"

import { useAuth } from "@/context/auth-context"
import { useCategorias } from "@/hooks/use-categorias"
import { useProductColors } from "@/hooks/use-product-colors"
import { useSiteSettings } from "@/hooks/use-site-settings"
import { useProductos } from "@/hooks/use-productos"
import { firstUsableImage } from "@/lib/products/admin-product-visuals"
import {
  getProductoById,
  getProductosPage,
  mergeProducto,
} from "@/lib/supabase/queries/productos"
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
type VariantFilter = "todas" | "sin_variantes"
type ProductView = "productos" | "categorias"
export type ProductSortKey = "nombre" | "stock" | "sku" | "color"
export type SortDirection = "asc" | "desc"

function parseStockValue(value: string) {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function getMergeRowImage(product: SupabaseProducto) {
  return firstUsableImage(
    product.imagen_principal,
    [...(product.imagenes_producto ?? [])]
      .sort((left, right) => left.orden - right.orden || left.id - right.id)
      .map((image) => image.url),
  )
}

function getMergeRowSku(product: SupabaseProducto) {
  const primaryVariantSku = [...(product.producto_variantes ?? [])]
    .sort((left, right) => left.orden - right.orden || left.id - right.id)[0]
    ?.sku?.trim()

  return product.sku?.trim() || primaryVariantSku || null
}

function MergeProductThumbnail({
  image,
  alt,
}: {
  image: string | null | undefined
  alt: string
}) {
  return (
    <span className="relative flex aspect-square size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black/30">
      {image ? (
        <Image src={image} alt={alt} fill sizes="40px" className="object-cover" />
      ) : (
        <ImageIcon className="size-4 text-white/22" aria-hidden="true" />
      )}
    </span>
  )
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
  const { isSuperAdmin } = useAuth()
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
  const [pendingMerge, setPendingMerge] = useState<SupabaseProducto | null>(null)
  const [mergeSearch, setMergeSearch] = useState("")
  const [mergeResults, setMergeResults] = useState<SupabaseProducto[]>([])
  const [mergeSearching, setMergeSearching] = useState(false)
  const [mergeTarget, setMergeTarget] = useState<SupabaseProducto | null>(null)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState("")
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
  const [variantFilter, setVariantFilter] =
    useState<VariantFilter>("todas")
  const [sortBy, setSortBy] = useState<ProductSortKey>("nombre")
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc")
  const [view, setView] = useState<ProductView>("productos")
  const {
    productos,
    total,
    variantIssues,
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
    variantFilter,
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
    variantFilter,
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
  const visibleVariantIssueCount = useMemo(
    () =>
      productos.filter((product) => {
        const variants = product.producto_variantes ?? []
        return (
          variants.length === 0 ||
          variants.some((variant) => !variant.sku?.trim())
        )
      }).length,
    [productos],
  )
  const effectiveVariantIssues = {
    count: Math.max(variantIssues.count, visibleVariantIssueCount),
    hasIssues:
      variantIssues.hasIssues || visibleVariantIssueCount > 0,
  }

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
    const deleted = await deleteProducto(pendingDelete.id, isSuperAdmin)
    setDeletingId(null)
    if (deleted) setPendingDelete(null)
  }

  const handleMerge = (producto: SupabaseProducto) => {
    setPendingMerge(producto)
    setMergeSearch("")
    setMergeResults([])
    setMergeTarget(null)
    setMergeError("")
  }

  useEffect(() => {
    if (!pendingMerge) return
    const term = mergeSearch.trim()

    let cancelled = false
    setMergeSearching(true)
    const timer = window.setTimeout(
      async () => {
        try {
          const result = await getProductosPage({
            search: term,
            pageSize: 20,
            activeFilter: "todos",
          })
          if (!cancelled) {
            setMergeResults(
              result.productos.filter((item) => item.id !== pendingMerge.id),
            )
          }
        } catch {
          if (!cancelled) setMergeResults([])
        } finally {
          if (!cancelled) setMergeSearching(false)
        }
      },
      term ? 300 : 0,
    )

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mergeSearch, pendingMerge])

  const confirmMerge = async () => {
    if (!pendingMerge || !mergeTarget) return
    try {
      setMerging(true)
      setMergeError("")
      await mergeProducto(mergeTarget.id, pendingMerge.id)
      setPendingMerge(null)
      setMergeTarget(null)
      await reloadProductos()
    } catch (cause) {
      setMergeError(
        cause instanceof Error
          ? cause.message
          : "No se pudieron fusionar los productos.",
      )
    } finally {
      setMerging(false)
    }
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
        variantFilter={variantFilter}
        variantIssues={effectiveVariantIssues}
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
        onVariantFilterChange={setVariantFilter}
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
            isSuperAdmin={isSuperAdmin}
            onSort={handleSort}
            onEdit={(producto) => void handleEdit(producto)}
            onDelete={handleDelete}
            onMerge={handleMerge}
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
              {pendingDelete?.inventory_stock_summary?.physical ??
                pendingDelete?.stock ??
                0}{" "}
              {Math.abs(
                pendingDelete?.inventory_stock_summary?.physical ??
                  pendingDelete?.stock ??
                  0,
              ) === 1
                ? "unidad"
                : "unidades"}
            </span>
          </div>
        </div>
        <div className="mt-3 px-2 text-center text-xs leading-5 text-white/52">
          {isSuperAdmin ? (
            <p>
              Como SUPER ADMIN vas a eliminar el producto y todas sus
              variantes aunque tengan stock, compras, ventas o devoluciones
              asociadas. El historial comercial se conserva desvinculado
              (sin borrarse) para mantener la trazabilidad.
            </p>
          ) : (
            <p>
              Si el producto no tiene movimientos se elimina. Si tiene
              compras, ventas o devoluciones asociadas, se archiva para
              conservar la trazabilidad del inventario.
            </p>
          )}
          <p className="mt-1.5 text-xs font-bold text-red-300/82">
            Esta acción no se puede deshacer.
          </p>
        </div>
      </AdminModal>

      <AdminModal
        open={Boolean(pendingMerge)}
        compact
        title="Fusionar con otro producto"
        onClose={() => {
          if (!merging) setPendingMerge(null)
        }}
        footer={
          <div className="flex justify-center gap-2">
            <AdminSecondaryButton
              size="sm"
              disabled={merging}
              onClick={() => setPendingMerge(null)}
            >
              Cancelar
            </AdminSecondaryButton>
            <AdminDangerButton
              size="sm"
              disabled={!mergeTarget || merging}
              onClick={() => void confirmMerge()}
            >
              {merging ? "Fusionando…" : "Fusionar"}
            </AdminDangerButton>
          </div>
        }
      >
        <p className="text-center text-xs leading-5 text-white/52">
          Vas a mover todas las variantes, compras, ventas y devoluciones de{" "}
          <span className="font-black text-white">{pendingMerge?.nombre}</span>{" "}
          hacia otro producto, y este va a eliminarse. Precio, fotos y
          descripción del producto elegido son los que van a quedar.
        </p>

        <div className="mt-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-white/35" />
            <input
              autoFocus
              value={mergeSearch}
              onChange={(event) => setMergeSearch(event.target.value)}
              placeholder="Buscar el producto que va a quedar…"
              className="h-10 w-full rounded-xl border border-white/12 bg-black/25 pl-9 pr-3 text-sm font-semibold text-white outline-none placeholder:text-white/35 focus:border-beyonix-sky/45"
            />
          </label>

          <div className="mt-2 max-h-[260px] overflow-y-auto rounded-xl border border-white/8">
            {mergeSearching && (
              <p className="px-3 py-4 text-center text-xs text-white/40">
                {mergeSearch.trim() ? "Buscando…" : "Cargando productos…"}
              </p>
            )}
            {!mergeSearching && mergeResults.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-white/40">
                {mergeSearch.trim()
                  ? "No encontramos productos con ese nombre."
                  : "No hay productos disponibles para fusionar."}
              </p>
            )}
            {!mergeSearching &&
              mergeResults.map((product) => {
                const selected = mergeTarget?.id === product.id
                const sku = getMergeRowSku(product)
                return (
                  <button
                    key={product.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setMergeTarget(product)}
                    className={`flex w-full cursor-pointer items-center gap-2.5 border-b border-white/6 px-3 py-1.5 text-left transition last:border-b-0 ${
                      selected
                        ? "bg-beyonix-blue/15 ring-1 ring-inset ring-beyonix-sky/40"
                        : "hover:bg-white/[0.04]"
                    }`}
                  >
                    <MergeProductThumbnail
                      image={getMergeRowImage(product)}
                      alt={product.nombre}
                    />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className="min-w-0 truncate text-sm font-bold text-white/85">
                        {product.nombre}
                      </span>
                      {sku && (
                        <span className="shrink-0 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-9px font-bold uppercase tracking-wide text-white/40">
                          SKU: {sku}
                        </span>
                      )}
                    </span>
                    {selected && (
                      <Check className="size-4 shrink-0 text-beyonix-sky" />
                    )}
                  </button>
                )
              })}
          </div>
        </div>

        {mergeTarget && (
          <p className="mt-2 text-center text-11px font-bold text-white/45">
            Va a quedar:{" "}
            <span className="text-white/75">{mergeTarget.nombre}</span>
          </p>
        )}

        {mergeError && (
          <p className="mt-3 text-center text-xs font-bold text-red-300/85">
            {mergeError}
          </p>
        )}
      </AdminModal>
    </div>
  )
}
