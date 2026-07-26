"use client"

import { useCallback, useEffect, useState } from "react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

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
  categoryId = null,
  stockFilter = "todos",
  activeFilter = "todos",
  featuredFilter = "todos",
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
          categoryId,
          stockFilter,
          activeFilter,
          featuredFilter,
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
      enabled,
      featuredFilter,
      lowStockThreshold,
      page,
      pageSize,
      search,
      stockFilter,
    ])

  useEffect(() => {
    void loadProductos()
  }, [loadProductos])

  const handleDelete =
    async (id: number) => {
      try {
        await deleteProducto(id)

        setProductos((prev) =>
          prev.filter(
            (p) => p.id !== id
          )
        )
        setTotal((current) => Math.max(0, current - 1))

        return true
      } catch (err) {
        console.error(err)

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

    reloadProductos:
      loadProductos,

    deleteProducto:
      handleDelete,

    toggleProductoActivo:
      handleToggle,
  }
}
