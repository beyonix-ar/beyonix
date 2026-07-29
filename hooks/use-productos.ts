"use client"

import { useCallback, useEffect, useState } from "react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"
import { supabase } from "@/lib/supabase/client"

import {
  getProductosPage,
  deleteProducto,
  toggleProductoActivo,
  type ProductosPageOptions,
} from "@/lib/supabase/queries/productos"

export function useProductos({
  enabled = true,
  page = 1,
  pageSize = 25,
  search = "",
  colorSearch = "",
  categoryId = null,
  stockFilter = "todos",
  stockFrom = null,
  stockTo = null,
  activeFilter = "todos",
  featuredFilter = "todos",
  sortBy = "nombre",
  sortDirection = "asc",
  lowStockThreshold = 5,
  availableStockThreshold = 6,
}: ProductosPageOptions & { enabled?: boolean } = {}) {
  const [productos, setProductos] =
    useState<SupabaseProducto[]>([])
  const [total, setTotal] = useState(0)

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const loadProductos =
    useCallback(async () => {
      if (!enabled) {
        setLoading(false)
        return
      }

      try {
        setLoading(true)

        const result = await getProductosPage({
          page,
          pageSize,
          search,
          colorSearch,
          categoryId,
          stockFilter,
          stockFrom,
          stockTo,
          activeFilter,
          featuredFilter,
          sortBy,
          sortDirection,
          lowStockThreshold,
          availableStockThreshold,
        })

        setProductos(result.productos)
        setTotal(result.total)
        setError(null)
      } catch (err) {
        console.error(err)

        setError(
          "Error cargando productos."
        )
      } finally {
        setLoading(false)
      }
    }, [
      activeFilter,
      availableStockThreshold,
      categoryId,
      colorSearch,
      enabled,
      featuredFilter,
      lowStockThreshold,
      page,
      pageSize,
      search,
      sortBy,
      sortDirection,
      stockFrom,
      stockFilter,
      stockTo,
    ])

  useEffect(() => {
    void loadProductos()
  }, [loadProductos])

  useEffect(() => {
    if (!enabled) return

    let timer: ReturnType<typeof setTimeout> | null = null
    const reload = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void loadProductos()
      }, 180)
    }
    const channel = supabase
      .channel(`admin-product-stock-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "productos" },
        reload,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "producto_variantes" },
        reload,
      )
      .subscribe()

    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [enabled, loadProductos])

  const handleDelete =
    async (id: number, force = false) => {
      try {
        const result = await deleteProducto(id, { force })

        if (result.mode === "deleted") {
          setProductos((prev) =>
            prev.filter(
              (p) => p.id !== id
            )
          )
          setTotal((current) => Math.max(0, current - 1))
        } else {
          setProductos((prev) =>
            prev.map((product) =>
              product.id === id
                ? { ...product, activo: false, destacado: false }
                : product
            )
          )
        }
        setActionMessage(result.message)
        setActionError(null)

        return true
      } catch (err) {
        setActionMessage(null)
        setActionError(
          err instanceof Error
            ? err.message
            : "No se pudo eliminar el producto.",
        )

        return false
      }
    }

  const handleToggle =
    async (
      producto: SupabaseProducto
    ) => {
      try {
        const updated =
          await toggleProductoActivo(
            producto
          )

        setProductos((prev) =>
          prev.map((p) =>
            p.id === updated.id
              ? {
                  ...p,
                  ...updated,
                  producto_variantes:
                    p.producto_variantes,
                }
              : p
          )
        )

        return true
      } catch (err) {
        console.error(err)

        return false
      }
    }

  return {
    productos,
    total,
    page,
    pageSize,
    loading,
    error,
    actionMessage,
    actionError,

    reloadProductos:
      loadProductos,

    deleteProducto:
      handleDelete,

    toggleProductoActivo:
      handleToggle,
  }
}
