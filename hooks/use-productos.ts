"use client"

import { useCallback, useEffect, useState } from "react"

import type {
  SupabaseProducto,
} from "@/lib/supabase/types"

import {
  getProductos,
  deleteProducto,
  toggleProductoActivo,
} from "@/lib/supabase/queries/productos"

export function useProductos() {
  const [productos, setProductos] =
    useState<SupabaseProducto[]>([])

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)

  const loadProductos =
    useCallback(async () => {
      try {
        setLoading(true)

        setProductos(
          await getProductos()
        )

        setError(null)
      } catch (err) {
        console.error(err)

        setError(
          "Error cargando productos."
        )
      } finally {
        setLoading(false)
      }
    }, [])

  useEffect(() => {
    loadProductos()
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
